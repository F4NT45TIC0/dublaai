import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const VOICE_FIXTURE = resolve(import.meta.dirname, 'tests/e2e/fixtures/voice-30s.wav')
const requestedPort = Number(process.env['PLAYWRIGHT_PORT'] ?? 3100)
const PORT =
  Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535
    ? requestedPort
    : 3100
const BASE_URL = `http://127.0.0.1:${String(PORT)}`
const REUSE_EXISTING_SERVER = process.env['PLAYWRIGHT_REUSE_SERVER'] === '1'

/** Partidas do teste vivem fora do repositório e somem com o diretório temporário. */
const MATCH_DIR = join(tmpdir(), 'dublaai-partidas-e2e')

/**
 * E2E do fluxo de dublagem (§77).
 *
 * O microfone real não existe em CI, então o Chromium recebe um arquivo como
 * fonte de captura. As flags:
 *
 *   --use-fake-ui-for-media-stream    concede a permissão sem diálogo
 *   --use-fake-device-for-media-stream  cria um dispositivo virtual
 *   --use-file-for-fake-audio-capture   alimenta esse dispositivo com o WAV
 *   --autoplay-policy                   o vídeo precisa tocar sem gesto
 *
 * Os testes rodam contra o build de PRODUÇÃO. O servidor de dev embute o
 * overlay de erros e recompila sob demanda, o que introduz atrasos que viram
 * instabilidade em asserções de tempo.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI'] ? 'github' : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'off',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${VOICE_FIXTURE}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * Por padrão o Playwright sobe e derruba o servidor em toda execução.
   *
   * `reuseExistingServer` parece conveniente, mas reaproveita um processo que
   * pode ter sido iniciado contra um `.next` anterior: o servidor continua
   * servindo um manifesto antigo, os chunks respondem 404, a hidratação nunca
   * acontece e TODOS os testes falham em `expect(...).toBeVisible()` — um
   * sintoma que não tem nada a ver com a causa. Custa alguns segundos por
   * execução e elimina uma classe inteira de falso negativo. O opt-in por
   * variável existe só para execuções diagnósticas que controlam o servidor.
   */
  webServer: {
    command: `node apps/web/node_modules/next/dist/bin/next start apps/web --port ${String(PORT)}`,
    url: BASE_URL,
    env: {
      // O modo online precisa de armazenamento compartilhado. Na Vercel é o
      // Blob; aqui a build de produção roda num processo só, então o disco
      // serve — e a variável deixa isso explícito em vez de acontecer sozinho.
      DUBLA_MATCH_DIR: MATCH_DIR,
    },
    reuseExistingServer: REUSE_EXISTING_SERVER,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
