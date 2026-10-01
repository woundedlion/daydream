import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staticSpecifiers } from './helpers/module_graph.js';

test('static specifiers include long import clauses and retain source order', () => {
  const names = Array.from({ length: 60 }, (_, index) => `long_name_${index}`).join(',\n');
  assert.deepEqual(staticSpecifiers(`import 'first';\nimport {${names}} from 'three';
    export { value } from 'second'; export * from 'third';
    const text = "import 'ignored'"; import('dynamic');`),
  ['first', 'three', 'second', 'third']);
});
