import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vendorAddonsFromSource } from '../scripts/vendor-imports.mjs';

test('vendor scanner follows import and re-export literals, including escapes', () => {
  const source = `import 'three/addons/a.js';
    export { x } from 'three/addons/b.js';
    export * from 'three/addons/c.js';
    await import('three/addons/d.js');
    import './local.js'; const ignored = "three/addons/unused.js";`;
  assert.deepEqual(vendorAddonsFromSource(source, 'app.js'), ['a.js', 'b.js', 'c.js', 'd.js']);
  assert.deepEqual(vendorAddonsFromSource(String.raw`import 'three/addons/\u0061.js';`, 'app.js'), ['a.js']);
});

test('vendor scanner isolates inline scripts from import maps and HTML text', () => {
  assert.deepEqual(vendorAddonsFromSource(`<p>three/addons/unused.js</p>
    <script type="importmap">{"imports":{}}</script>
    <script type="application/json">{}</script>
    <script type="module">import 'three/addons/a.js'</script>`, 'index.html'), ['a.js']);
});

test('vendor scanner rejects computed imports except fixed relative URL constants', () => {
  for (const source of ['import(name)', 'import(`three/addons/${name}`)',
    "const URL_PATH = new URL('https://example.test', import.meta.url).href; import(URL_PATH)",
    "let URL_PATH = new URL('./local.js', import.meta.url).href; import(URL_PATH)"]) {
    assert.throws(() => vendorAddonsFromSource(source, 'app.js'), /literal specifiers/);
  }
  assert.deepEqual(vendorAddonsFromSource(
    "const COMPILER_URL = new URL('../compiler.js', import.meta.url).href; await import(COMPILER_URL)",
    'app.js'), []);
});
