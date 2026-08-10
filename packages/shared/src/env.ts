import { z } from 'zod'

/**
 * Validação de ambiente no boot (§90).
 *
 * A aplicação recusa iniciar com configuração inválida em vez de falhar no
 * meio de uma gravação, que é quando o usuário mais perde.
 *
 * Cliente e servidor são separados: variáveis `NEXT_PUBLIC_*` são embutidas no
 * bundle e nunca podem conter segredo.
 */

const clientEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_MEDIA_BASE_URL: z.string().default('/media'),
})

export type ClientEnv = z.infer<typeof clientEnvSchema>

export function parseClientEnv(source: Record<string, string | undefined>): ClientEnv {
  const parsed = clientEnvSchema.safeParse({
    NEXT_PUBLIC_SITE_URL: source['NEXT_PUBLIC_SITE_URL'],
    NEXT_PUBLIC_MEDIA_BASE_URL: source['NEXT_PUBLIC_MEDIA_BASE_URL'],
  })

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Variáveis de ambiente do cliente inválidas:\n${details}`)
  }

  return parsed.data
}
