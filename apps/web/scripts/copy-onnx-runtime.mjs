/**
 * Copia o runtime do onnxruntime-web para `public/onnx/`.
 *
 * Duas razões, as duas de peso:
 *
 * 1. CSP. Quando o `.mjs` do wasm vem de outra origem, o onnxruntime baixa o
 *    arquivo e importa a partir de um `blob:` — e `script-src` bloqueia isso,
 *    corretamente. Servindo da própria origem ele importa direto, sem blob, e
 *    a política continua fechada.
 * 2. Nada de terceiro em runtime. O runtime passa a sair do mesmo domínio que
 *    o resto da aplicação.
 *
 * Os arquivos NÃO ficam versionados (são ~74 MB e reproduzíveis): este script
 * roda antes de `next build` e de `next dev`.
 */

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'

// O pnpm não achata o grafo: o onnxruntime-web é dependência da
// transformers.js, então a resolução precisa partir de lá, e não daqui.
const require = createRequire(import.meta.url)
const transformersEntry = require.resolve('@huggingface/transformers')
const onnxEntry = createRequire(transformersEntry).resolve('onnxruntime-web')

// O pacote não exporta `./package.json`, então a raiz sai do caminho do próprio
// entry — que sempre mora dentro de `<raiz>/dist/`.
const marker = `${sep}onnxruntime-web${sep}`
const rootEnd = onnxEntry.lastIndexOf(marker)
if (rootEnd === -1) throw new Error(`Não localizei a raiz do onnxruntime-web em ${onnxEntry}`)
const distDir = join(onnxEntry.slice(0, rootEnd + marker.length), 'dist')
const outputDir = resolve(import.meta.dirname, '..', 'public', 'onnx')

/**
 * As quatro variantes do runtime. Qual delas carrega é decisão do próprio
 * onnxruntime, em tempo de execução, conforme o que o navegador oferece
 * (JSPI, asyncify, WebGPU). Escolher só uma daqui quebraria em navegador
 * diferente do que foi testado — e o navegador só pede uma, então o custo de
 * ter as quatro publicadas é de disco, não de banda.
 */
const FILES = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
]

await mkdir(outputDir, { recursive: true })

let copied = 0
for (const file of FILES) {
  const source = join(distDir, file)
  const target = join(outputDir, file)

  // Copiar ~74 MB a cada `next dev` atrasaria o arranque sem motivo.
  const [sourceStat, targetStat] = await Promise.all([
    stat(source),
    stat(target).catch(() => null),
  ])
  if (targetStat?.size === sourceStat.size) continue

  await copyFile(source, target)
  copied += 1
}

console.log(
  copied === 0
    ? 'onnxruntime: runtime local já estava em dia'
    : `onnxruntime: ${String(copied)} arquivo(s) copiados para public/onnx/`,
)
