import { z } from 'zod'

/**
 * Validação de toda entrada externa (§80).
 *
 * `scene.json` é conteúdo carregado de fora do processo: ele alimenta a
 * timeline, o VAD e o cálculo de score. Um `startMs` fora da duração ou
 * segmentos sobrepostos produziriam um score errado de forma silenciosa —
 * a classe de bug mais perigosa do projeto (docs/RISKS.md R-03).
 */

const msSchema = z.number().int().nonnegative().max(600_000)

export const contentRightsSchema = z.object({
  source: z.string().min(1),
  owner: z.string().min(1),
  licenseType: z.enum(['original', 'public_domain', 'cc_by', 'licensed', 'user_upload']),
  licenseStart: z.string().optional(),
  licenseEnd: z.string().optional(),
  territories: z.array(z.string()).default([]),
  usageRestrictions: z.string().optional(),
  proofReference: z.string().optional(),
})

export const characterSchema = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  name: z.string().min(1).max(40),
  colorToken: z.string().min(1),
  patternToken: z.string().min(1),
})

export const speakerSegmentSchema = z
  .object({
    id: z.string().min(1),
    sceneId: z.string().min(1),
    characterId: z.string().min(1),
    startMs: msSchema,
    endMs: msSchema,
    text: z.string().min(1).max(500),
    orderIndex: z.number().int().nonnegative(),
  })
  .refine((s) => s.endMs > s.startMs, {
    message: 'endMs precisa ser maior que startMs',
    path: ['endMs'],
  })

export const subtitleSegmentSchema = z
  .object({
    id: z.string().min(1),
    sceneId: z.string().min(1),
    speakerSegmentId: z.string().optional(),
    startMs: msSchema,
    endMs: msSchema,
    text: z.string().min(1).max(500),
  })
  .refine((s) => s.endMs > s.startMs, {
    message: 'endMs precisa ser maior que startMs',
    path: ['endMs'],
  })

export const workSchema = z.object({
  id: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug aceita apenas minúsculas, números e hífen'),
  title: z.string().min(1).max(120),
  type: z.enum(['film', 'series', 'animation', 'cartoon', 'anime', 'meme', 'other']),
  year: z.number().int().min(1900).max(2200).optional(),
  synopsis: z.string().max(1000).optional(),
  posterKey: z.string().optional(),
})

export const sceneDetailSchema = z
  .object({
    id: z.string().min(1),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'slug aceita apenas minúsculas, números e hífen'),
    workId: z.string().min(1),
    title: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    // §9 — nenhuma cena passa de 60s no MVP
    durationMs: z.number().int().positive().max(60_000),
    difficulty: z.enum(['easy', 'medium', 'hard', 'insane']),
    language: z.string().min(2).max(10),
    videoKey: z.string().min(1),
    referenceAudioKey: z.string().min(1),
    featuresKey: z.string().min(1),
    thumbnailKey: z.string().optional(),
    characterCount: z.number().int().positive().max(10),
    status: z.enum([
      'draft',
      'processing',
      'review',
      'published',
      'blocked',
      'expired',
      'archived',
    ]),
    work: workSchema,
    characters: z.array(characterSchema).min(1),
    speakerSegments: z.array(speakerSegmentSchema).min(1),
    subtitleSegments: z.array(subtitleSegmentSchema).min(1),
    // §39 — nenhuma cena existe sem direitos declarados
    rights: contentRightsSchema,
  })
  .superRefine((scene, ctx) => {
    const characterIds = new Set(scene.characters.map((c) => c.id))

    for (const segment of scene.speakerSegments) {
      if (!characterIds.has(segment.characterId)) {
        ctx.addIssue({
          code: 'custom',
          message: `segmento ${segment.id} referencia personagem inexistente: ${segment.characterId}`,
          path: ['speakerSegments'],
        })
      }
      if (segment.endMs > scene.durationMs) {
        ctx.addIssue({
          code: 'custom',
          message: `segmento ${segment.id} termina em ${String(segment.endMs)}ms, além da duração da cena (${String(scene.durationMs)}ms)`,
          path: ['speakerSegments'],
        })
      }
    }

    // Sobreposição quebraria a atribuição de fala a personagem no score.
    // O MVP assume um falante por vez (§10).
    const ordered = [...scene.speakerSegments].sort((a, b) => a.startMs - b.startMs)
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]
      const current = ordered[i]
      if (previous && current && current.startMs < previous.endMs) {
        ctx.addIssue({
          code: 'custom',
          message: `segmentos ${previous.id} e ${current.id} se sobrepõem`,
          path: ['speakerSegments'],
        })
      }
    }

    for (const subtitle of scene.subtitleSegments) {
      if (subtitle.endMs > scene.durationMs) {
        ctx.addIssue({
          code: 'custom',
          message: `legenda ${subtitle.id} termina além da duração da cena`,
          path: ['subtitleSegments'],
        })
      }
    }
  })

export type SceneDetailInput = z.infer<typeof sceneDetailSchema>

export const catalogSchema = z.array(sceneDetailSchema)
