//
// Static checks on daydream.js's WASM-ready block. daydream.js is the app's
// composition root: it builds a WebGL Daydream and mounts the GUI at module
// scope, so it cannot be imported here — these read its source instead.
//
// The engine is late-bound. DeepLinkGUI replays a URL-hydrated control's
// onChange at registration, during module evaluation, while host.engine is
// still null. A control whose only durable home is the engine therefore has to
// be re-applied once createHolosphereModule() resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../daydream.js', import.meta.url), 'utf8');

const WASM_INIT = 'createHolosphereModule().then(';

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
 * The body of the createHolosphereModule().then() handler.
 * @returns {string} The handler source.
 */
function wasmReadyBlock() {
  const at = SOURCE.indexOf(WASM_INIT);
  assert.ok(at >= 0, `daydream.js must still initialize the engine via ${WASM_INIT}`);
  return balanced(SOURCE, at + WASM_INIT.length - 1);
}

test('the WASM-ready block re-applies Pole LOD to the freshly built engine', () => {
  const body = wasmReadyBlock();
  const call = body.match(/host\.engine\.setPoleLod\(\s*([^)]*?)\s*\)/);
  assert.ok(call,
    'the Pole LOD onChange runs while host.engine is null, so the block that '
    + 'builds the engine must call host.engine.setPoleLod(...); without it a '
    + '?view.poleLod deep link shows in the GUI but never reaches the engine');
  assert.equal(call[1], 'poleLodState.poleLod',
    'the replay must read the live Pole LOD state so it carries the URL value '
    + 'when there is one and the default otherwise');
});

test('the Pole LOD control defaults to 0, leaving the feature off', () => {
  const decl = SOURCE.match(/const poleLodState = \{\s*poleLod:\s*([-\d.]+)\s*\}/);
  assert.ok(decl, 'daydream.js must declare poleLodState with a poleLod default');
  assert.equal(Number(decl[1]), 0,
    'near-pole decimation is deliberately off by default; the WASM-ready '
    + 'replay must not turn it on when no deep link is present');
});
