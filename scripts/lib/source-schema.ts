import { z } from 'zod'

/**
 * Esquema da FONTE autoral de uma cena.
 *
 * Repare no que NÃO está aqui: `startMs` e `endMs`. Os tempos não são
 * escritos à mão — eles saem da duração real da fala sintetizada, medida na
 * ingestão. Declarar tempos e depois sintetizar áudio que não bate com eles é
 * exatamente o risco R-03: a referência mentiria sobre si mesma e o score
 * mediria contra dados errados, de forma silenciosa e convincente.
 */

export const voiceSchema = z.object({
  /** −10..10 no SAPI. Diferencia personagens sem trocar de voz. */
  rate: z.number().int().min(-10).max(10).default(0),
  /** Ajuste de altura em SSML, ex. "+12%". */
  pitch: z.string().default('+0%'),
})

export const sourceCharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  colorToken: z.string().min(1),
  patternToken: z.string().min(1),
  voice: voiceSchema,
})

export const sourceLineSchema = z.object({
  characterId: z.string().min(1),
  text: z.string().min(1).max(300),
  /** Silêncio antes desta fala, contado a partir do fim da anterior. */
  gapBeforeMs: z.number().int().min(0).max(5_000),
})

export const sourceSceneSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'slug aceita apenas minúsculas, números e hífen'),
    title: z.string().min(1).max(160),
    description: z.string().max(1_000).optional(),
    difficulty: z.enum(['easy', 'medium', 'hard', 'insane']),
    leadInMs: z.number().int().min(0).max(5_000).default(800),
    tailMs: z.number().int().min(0).max(5_000).default(700),
    work: z.object({
      slug: z.string().regex(/^[a-z0-9-]+$/),
      title: z.string().min(1).max(120),
      type: z.enum(['film', 'series', 'animation', 'cartoon', 'anime', 'meme', 'other']),
      year: z.number().int().min(1900).max(2200).optional(),
      synopsis: z.string().max(1_000).optional(),
    }),
    characters: z.array(sourceCharacterSchema).min(1).max(6),
    lines: z.array(sourceLineSchema).min(1).max(30),
    rights: z.object({
      source: z.string().min(1),
      owner: z.string().min(1),
      licenseType: z.enum(['original', 'public_domain', 'cc_by', 'licensed', 'user_upload']),
      territories: z.array(z.string()).default([]),
      usageRestrictions: z.string().optional(),
      proofReference: z.string().optional(),
    }),
  })
  .superRefine((scene, ctx) => {
    const ids = new Set(scene.characters.map((character) => character.id))
    scene.lines.forEach((line, index) => {
      if (!ids.has(line.characterId)) {
        ctx.addIssue({
          code: 'custom',
          message: `fala ${String(index)} referencia personagem inexistente: ${line.characterId}`,
          path: ['lines', index, 'characterId'],
        })
      }
    })
  })

export type SourceScene = z.infer<typeof sourceSceneSchema>
export type SourceCharacter = z.infer<typeof sourceCharacterSchema>
