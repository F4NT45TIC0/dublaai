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
