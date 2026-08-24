// Lint config for the repo's JavaScript, enforced by the `lint` step in
// .github/workflows/js-unit-suite.yml.
//
// The recommended set only -- the rules that catch defects (undeclared names,
// unreachable code, duplicate keys, unused bindings). No stylistic rules and no
// formatter: the tree passes this unmodified, so the gate reports real breakage
// rather than layout opinions.
import js from '@eslint/js';
import globals from 'globals';

export default [
  // eslint reads no .gitignore. holosphere_wasm.js is Emscripten glue built in
  // the engine repo; vendor/ and three.js/ are third-party drops the tool pages
  // load offline; .worktrees/ holds linked checkouts of this same tree, each
  // already linted where it is pushed from.
  {
    ignores: [
      'holosphere_wasm.js', 'vendor/**', 'three.js/**', 'engine/**',
      '.worktrees/**',
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
    files: ['segment_worker.js'],
    languageOptions: { globals: globals.worker },
  },
];
