//
// daydream.js is the app's composition root: it builds a WebGL Daydream and
// mounts the GUI at module scope, so it cannot be imported here. Everything with
// behaviour of its own lives in an injectable factory and is driven for real in
// tests/app_lifecycle.test.js — the Pole LOD late-bind, the keydown guard, the
// module-load handlers, the teardown order. What is left is the wiring itself:
// which closures this file hands those factories. Only a source read can see
// that, so these two cases read it, and each one names the failure it prevents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../daydream.js', import.meta.url), 'utf8');

const WASM_INIT = 'createModuleLoadHandlers(';

/**
 * Extracts the text between a call's parentheses, skipping parens that sit
 * inside strings, template literals, or comments.
 * @param {string} src - Source text.
 * @param {number} open - Index of the opening '('.
 * @returns {string} The argument-list text.
 */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const eol = src.indexOf('\n', i);
      if (eol < 0) break;
      i = eol;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  assert.fail(`daydream.js: unbalanced parentheses from index ${open}`);
}

/**
 * The dependency block wiring the WASM module promise, including the startup
 * handler that builds the engine.
 * @returns {string} The argument source.
 */
function wasmReadyBlock() {
  const at = SOURCE.indexOf(WASM_INIT);
  assert.ok(at >= 0, `daydream.js must still wire the engine load through ${WASM_INIT}`);
  return balanced(SOURCE, at + WASM_INIT.length - 1);
}

test('the teardown is retained and reachable from the module-load handlers', () => {
  assert.match(SOURCE, /appTeardown = createAppTeardown\(/,
    "createAppTeardown()'s result must be kept: the load handlers dispose the "
    + 'app on a failed load and skip startup once a page discard has won');
  assert.match(wasmReadyBlock(), /teardown:\s*\(\)\s*=>\s*appTeardown/,
    'the handlers must read the teardown lazily; it is built after them');
});

test('the discard path frees an engine built after disposal', () => {
  const body = wasmReadyBlock();
  assert.match(body, /discardStartup:/,
    'a startup that loses the disposal race owns everything it built; dispose() '
    + 'has already run and will not revisit it');
  assert.match(body, /host\.engine\?\.delete\(\)/,
    'a WASM engine handle must be deleted, not merely dropped');
});

test('the late-bound engine controls are re-applied once the engine exists', () => {
  assert.match(wasmReadyBlock(), /poleLod\.replay\(\)/,
    'the Pole LOD onChange runs while host.engine is null, so the block that '
    + 'builds the engine must replay the binding; without it a ?view.poleLod '
    + 'deep link shows in the GUI but never reaches the engine');
});
