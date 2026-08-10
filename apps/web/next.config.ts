import type { NextConfig } from 'next'

/**
 * CSP restritiva (docs/SECURITY.md §2).
 *
 * `worker-src blob:` é necessário porque o worker de análise é instanciado a
 * partir de um bundle; `media-src blob:` porque a gravação do usuário vira um
 * object URL para o playback. `connect-src https:` permite buscar somente a
 * URL direta informada pela própria pessoa; o player recebe o Blob local e
 * não incorpora hosts, fontes ou analytics de terceiros.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // Next injeta scripts inline com nonce em produção; em dev o HMR exige eval.
  process.env.NODE_ENV === 'development'
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : // 'wasm-unsafe-eval' libera APENAS WebAssembly.compile/instantiate —
      // não é o eval de JS. Necessário para a transcrição local (onnxruntime).
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  // A exportação lê o WAV local (blob:) e a entrada por URL baixa uma mídia
  // HTTPS com CORS. HTTP fica limitado aos hosts locais para desenvolvimento.
  "connect-src 'self' blob: https: http://localhost:* http://127.0.0.1:*",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Pacotes internos são consumidos como TypeScript, sem etapa de build.
  transpilePackages: ['@dubla/ui', '@dubla/shared', '@dubla/audio', '@dubla/dsp', '@dubla/scoring'],

  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // O microfone é usado só pela própria origem (§20).
          { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
        ],
      },
      {
        // Mídia de cena é imutável: o nome muda quando o conteúdo muda (§60).
        source: '/media/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ])
  },
}

export default nextConfig
