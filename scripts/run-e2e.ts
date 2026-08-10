/**
 * Sobe o build de produção numa única árvore de processo e executa Playwright.
 *
 * No Windows, deixar o `webServer` encadear pnpm -> cmd -> Next pode impedir o
 * encerramento limpo. Este runner mantém o processo Node do Next como filho
 * direto e sempre o finaliza no `finally`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = resolve(import.meta.dirname, '..')
const WEB_ROOT = resolve(ROOT, 'apps', 'web')
const NEXT_CLI = resolve(WEB_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
const PLAYWRIGHT_CLI = resolve(ROOT, 'node_modules', '@playwright', 'test', 'cli.js')
const requestedPort = Number(process.env['PLAYWRIGHT_PORT'] ?? 3100)

/** Partidas do teste vivem fora do repositório e somem com o diretório temporário. */
const MATCH_DIR = join(tmpdir(), 'dublaai-partidas-e2e')
const PORT =
  Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535
    ? requestedPort
    : 3100
const BASE_URL = `http://127.0.0.1:${String(PORT)}`

async function isServerReady(): Promise<boolean> {
  try {
    const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(1_000) })
    return response.status < 500
  } catch {
    return false
  }
}

async function waitForServer(server: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await isServerReady()) return
    if (server.exitCode !== null) {
      throw new Error(`O servidor de teste encerrou com código ${String(server.exitCode)}.`)
    }
    await delay(250)
  }
  throw new Error('O servidor de teste não ficou pronto em 30 segundos.')
}

async function stopServer(server: ChildProcess | null): Promise<void> {
  if (server?.exitCode !== null) return
  server.kill()
  const stopped = await Promise.race([
    once(server, 'exit').then(() => true),
    delay(5_000).then(() => false),
  ])
  if (!stopped) server.kill('SIGKILL')
}

async function run(): Promise<number> {
  const reuseExisting = process.env['PLAYWRIGHT_REUSE_SERVER'] === '1'
  let server: ChildProcess | null = null

  try {
    if (reuseExisting) {
      if (!(await isServerReady())) {
        throw new Error(`PLAYWRIGHT_REUSE_SERVER=1, mas não há servidor em ${BASE_URL}.`)
      }
    } else {
      if (await isServerReady()) {
        throw new Error(`A porta ${String(PORT)} já está ocupada por outro servidor.`)
      }
      server = spawn(process.execPath, [NEXT_CLI, 'start', '--port', String(PORT)], {
        cwd: WEB_ROOT,
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...process.env,
          // O modo online exige armazenamento compartilhado. Na Vercel é o
          // Blob; aqui a build roda num processo só, então o disco serve — e a
          // variável deixa isso explícito, em vez de acontecer por descuido.
          DUBLA_MATCH_DIR: MATCH_DIR,
        },
      })
      await waitForServer(server)
    }

    const playwright = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI, 'test', ...process.argv.slice(2)],
      {
        cwd: ROOT,
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...process.env,
          PLAYWRIGHT_PORT: String(PORT),
          PLAYWRIGHT_REUSE_SERVER: '1',
        },
      },
    )
    const [code, signal] = (await once(playwright, 'exit')) as [number | null, NodeJS.Signals | null]
    if (signal) throw new Error(`Playwright foi encerrado pelo sinal ${signal}.`)
    return code ?? 1
  } finally {
    await stopServer(server)
  }
}

try {
  process.exitCode = await run()
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exitCode = 1
}
