import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decodeWav } from '@dubla/dsp'

/**
 * Síntese de voz pelo SAPI do Windows.
 *
 * Escolhido por ser local, offline, sem chave e sem custo — e porque a saída é
 * conteúdo que nós geramos, sem nenhuma questão de direitos (§39/§40).
 *
 * Todas as falas de todas as cenas são sintetizadas em UM processo PowerShell.
 * Subir o runtime .NET e carregar a voz custa alguns segundos; fazer isso uma
 * vez por fala transformaria a ingestão em minutos de espera.
 */

export interface SynthRequest {
  readonly id: string
  readonly text: string
  readonly rate: number
  readonly pitch: string
  readonly outputPath: string
}

export interface SynthResult {
  readonly id: string
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly durationMs: number
}

const PREFERRED_VOICE_CULTURE = 'pt-BR'

/**
 * Sintetiza tudo e devolve as amostras já decodificadas.
 *
 * O SAPI grava direto em 16 kHz mono, que é exatamente a taxa de análise —
 * assim a referência não passa por nenhuma reamostragem antes de virar
 * features.
 */
export function synthesizeAll(requests: readonly SynthRequest[], workDir: string): SynthResult[] {
  if (requests.length === 0) return []

  mkdirSync(workDir, { recursive: true })
  const manifestPath = join(workDir, 'tts-manifest.json')
  const scriptPath = join(workDir, 'tts-run.ps1')

  for (const request of requests) mkdirSync(dirname(request.outputPath), { recursive: true })

  writeFileSync(
    manifestPath,
    JSON.stringify(requests.map(({ id, text, rate, pitch, outputPath }) => ({
      id,
      text,
      rate,
      pitch,
      outputPath,
    }))),
    'utf8',
  )

  writeFileSync(scriptPath, buildPowerShellScript(), 'utf8')

  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, manifestPath],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 10 * 60 * 1000 },
  )

  return requests.map((request) => {
    const file = readFileSync(request.outputPath)
    const decoded = decodeWav(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    )
    return {
      id: request.id,
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      durationMs: (decoded.samples.length / decoded.sampleRate) * 1000,
    }
  })
}

function buildPowerShellScript(): string {
  // O SSML é montado no PowerShell para que o texto passe por XML escaping lá,
  // e não por concatenação no TypeScript — apóstrofos e "&" são comuns em
  // diálogo e quebrariam o documento.
  return `
param([Parameter(Mandatory=$true)][string]$ManifestPath)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Speech

$manifest = Get-Content -Path $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

$voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled }
$target = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq '${PREFERRED_VOICE_CULTURE}' } | Select-Object -First 1
if ($null -eq $target) {
  Write-Host "AVISO: nenhuma voz ${PREFERRED_VOICE_CULTURE} instalada; usando a voz padrao do sistema."
} else {
  $synth.SelectVoice($target.VoiceInfo.Name)
  Write-Host "Voz selecionada: $($target.VoiceInfo.Name)"
}

$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($item in $manifest) {
  $synth.Rate = [int]$item.rate
  $synth.SetOutputToWaveFile($item.outputPath, $format)

  $escaped = [System.Security.SecurityElement]::Escape($item.text)
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'><prosody pitch='$($item.pitch)'>$escaped</prosody></speak>"

  try {
    $synth.SpeakSsml($ssml)
  } catch {
    # Nem toda voz SAPI aceita prosody. Cair para texto puro preserva a
    # ingestao; o personagem perde a variacao de altura, nao a fala.
    Write-Host "AVISO: SSML recusado para $($item.id); sintetizando texto puro."
    $synth.Speak($item.text)
  }

  $synth.SetOutputToNull()
}

$synth.Dispose()
Write-Host "Sintese concluida: $($manifest.Count) falas."
`.trimStart()
}
