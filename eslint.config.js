import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * Regras que codificam requisitos do projeto.
 *
 * Elas ficam agrupadas num único bloco `no-restricted-syntax` de propósito: em
 * flat config, dois blocos que definem a MESMA regra para os mesmos arquivos
 * não se somam — o último vence, e o primeiro some sem aviso.
 */
const projectRestrictions = [
  {
    selector: 'MemberExpression[property.name="getUserMedia"]',
    message: 'getUserMedia só pode ser chamado dentro de AudioCaptureService (§22). Use o serviço.',
  },
  {
    selector: 'CallExpression[callee.name="setInterval"]',
    message:
      'setInterval nunca é relógio (§112). Use MediaClock, requestAnimationFrame ou o agendador do Web Audio.',
  },
  {
    selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
    message:
      'Proibido. Legendas e textos de cena vêm de dados externos e são renderizados como texto (SECURITY.md §2).',
  },
]

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/web/public/media/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // §89 — tipos reais, não escapes
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' },
      ],
      // APIs de mídia são cheias de promessas; engolir uma silenciosamente
      // é como uma gravação trava sem ninguém perceber.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': ['error', ...projectRestrictions],
    },
  },

  // §22 — o serviço de captura é o único lugar autorizado a chamar getUserMedia.
  {
    files: ['packages/audio/src/capture/audio-capture-service.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...projectRestrictions.filter(
          (rule) => !rule.selector.includes('getUserMedia'),
        ),
      ],
    },
  },

  // React. O plugin ainda publica os configs no formato antigo (`plugins` como
  // array), que o ESLint 10 recusa — por isso ele é registrado à mão.
  // Hooks moram tanto em .tsx quanto em .ts (o orquestrador de gravação é .ts).
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  /**
   * As definições do DOM declaram `navigator.mediaDevices` e
   * `AudioContext.audioWorklet` como sempre presentes, e não é verdade: em
   * contexto inseguro (HTTP), em navegadores antigos e em WebViews eles
   * simplesmente não existem. As verificações aqui são guardas reais de
   * runtime — removê-las para agradar o lint trocaria uma tela de erro
   * explicativa por um TypeError.
   */
  {
    files: [
      'packages/audio/src/capture/audio-capture-service.ts',
      // Mesmo caso: `navigator.storage.getDirectory` (OPFS) é declarado como
      // sempre presente e não existe em Safari antigo nem em WebViews.
      'apps/web/lib/recording-store.ts',
    ],
    rules: { '@typescript-eslint/no-unnecessary-condition': 'off' },
  },

  // Os testes E2E instrumentam `getUserMedia` de propósito, para provar que
  // nenhuma track sobrevive à saída da página (§111.14). As demais restrições
  // do projeto continuam valendo aqui.
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...projectRestrictions.filter((rule) => !rule.selector.includes('getUserMedia')),
      ],
    },
  },

  // §115 — nada de score inventado.
  {
    files: ['packages/scoring/**/*.ts', 'packages/dsp/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'O motor de score é determinístico (§115). Aleatoriedade aqui é sempre um bug ou um mock escondido.',
        },
      ],
    },
  },

  // dsp e scoring precisam permanecer isomórficos.
  {
    files: ['packages/dsp/**/*.ts', 'packages/scoring/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'packages/dsp e packages/scoring rodam em worker e no servidor.' },
        {
          name: 'document',
          message: 'packages/dsp e packages/scoring rodam em worker e no servidor.',
        },
        {
          name: 'navigator',
          message: 'packages/dsp e packages/scoring rodam em worker e no servidor.',
        },
      ],
    },
  },

  // Scripts, configs e testes rodam no Node.
  {
    files: ['scripts/**/*.ts', '**/*.config.ts', '**/*.config.js', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
    rules: {
      // Fakes de teste imitam APIs do navegador; a rigidez ali atrapalha mais
      // do que protege.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  // AudioWorklet: escopo global próprio, sem DOM.
  // O spread vem PRIMEIRO: depois dele, `languageOptions` abaixo é o que vale.
  // Na ordem inversa, o preset apagaria os globais do worklet e todo
  // `currentFrame` viraria `no-undef`.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['apps/web/public/audio-worklet/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },

  prettier,
)
