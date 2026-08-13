import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'dsp',
          root: './packages/dsp',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'scoring',
          root: './packages/scoring',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'audio',
          root: './packages/audio',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
          setupFiles: ['./src/__tests__/setup.ts'],
        },
      },
      {
        // O app usa `jsx: preserve` para o compilador do Next. Nos testes,
        // Vite precisa transformar componentes TSX importados diretamente.
        oxc: { jsx: { runtime: 'automatic' } },
        // O `@/` do tsconfig do app. Sem ele, um import de valor por alias
        // quebra aqui e passa no build — os que existiam antes eram `import
        // type`, apagados na compilação, e por isso ninguém notou.
        resolve: {
          alias: { '@': resolve(import.meta.dirname, 'apps/web') },
        },
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['lib/**/*.test.ts'],
        },
      },
    ],
  },
})
