import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staticSpecifiers, relativeImports, reachableModules } from './helpers/module_graph.js';

test('static specifiers include long import clauses and retain source order', () => {
  const names = Array.from({ length: 60 }, (_, index) => `long_name_${index}`).join(',\n');
  assert.deepEqual(staticSpecifiers(`import 'first';\nimport {${names}} from 'three';
    export { value } from 'second'; export * from 'third';
    const text = "import 'ignored'"; import('dynamic');`),
  ['first', 'three', 'second', 'third']);
});

test('text imports resolve static, dynamic, JSDoc and worker dependencies across extensions', () => {
  assert.deepEqual(relativeImports(`import './side.mjs';
    export * from '../shared/base.js'; import('bare'); import('./dynamic.js');
    /** @type {import('../types/value.js').Value} */
    new Worker(new URL('./worker.js', import.meta.url));`, 'src/page/main.js'), [
    'src/page/side.mjs', 'src/shared/base.js', 'src/page/dynamic.js',
    'src/types/value.js', 'src/page/worker.js',
  ]);
});

test('reachability visits shared cycles once and respects caller exclusions', () => {
  const graph = { a: ['b', 'c'], b: ['a', 'd'], c: ['d'], d: ['unread'] };
  const visited = [];
  const reached = reachableModules(['a', 'a'], (file) => {
    visited.push(file);
    return graph[file];
  }, (file) => file !== 'd');
  assert.deepEqual([...reached], ['a', 'b', 'c']);
  assert.deepEqual(visited, ['a', 'b', 'c']);
});
