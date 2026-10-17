import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.vercel/**', '**/next-env.d.ts', 'apps/api/src/db/schema.ts', 'apps/web/public/agent/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Operational scripts run under plain Node.
    files: ['infra/**/*.mjs', '**/*.config.mjs', 'apps/*/scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
