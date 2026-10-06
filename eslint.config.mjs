// Lint config: eslint's recommended rules only, no stylistic rules.
import js from '@eslint/js';
import globals from 'globals';

export default [
  // eslint reads no .gitignore; these are generated, third-party or linked-checkout trees.
  {
    ignores: [
      'generated/holosphere_wasm.js', 'generated/shader/*.mjs', 'vendor/**', 'three.js/**', 'engine/**',
      '.worktrees/**', 'engine-bundle/**', '.hs-tmp-*/**', '.claude/**', 'prompts/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.js', 'tests/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/segments/segment_worker.js'],
    languageOptions: { globals: globals.worker },
  },
];
