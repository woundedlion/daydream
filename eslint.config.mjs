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
    files: ['scripts/**/*.mjs', 'tests/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // scripts/count-assertions.mjs wraps node:assert's function properties; the
    // callable default export is a binding inside the builtin and cannot be
    // wrapped, so `assert(x)` asserts uncounted and sits below its file's
    // committed floor, deletable without tripping the ratchet. It counts
    // invocations, not outcomes, so an assertion whose subject is a literal
    // holds that floor while covering nothing.
    files: ['tests/**/*.js'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'CallExpression[callee.type="Identifier"][callee.name="assert"]',
        message:
          'Call node:assert through a property (assert.ok(x)): a bare assert(x) ' +
          'is not counted by scripts/count-assertions.mjs.',
      }, {
        selector:
          'CallExpression[callee.object.name="assert"][callee.property.name!="fail"]' +
          ':matches([arguments.0.type="Literal"],' +
          ' [arguments.0.type="TemplateLiteral"][arguments.0.expressions.length=0])',
        message:
          'Assert a computed value, not a literal: assert.ok(true) runs, counts, ' +
          'and holds its floor in tests/assertion-floors.json while ' +
          'testing nothing.',
      }],
    },
  },
  {
    files: ['segment_worker.js'],
    languageOptions: { globals: globals.worker },
  },
];
