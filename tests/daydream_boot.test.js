//
// daydream.js is the app's composition root: it builds a WebGL Daydream and
// mounts the GUI at module scope, so it cannot be imported here. Everything with
// behaviour of its own lives in an injectable factory and is driven for real in
// tests/app_lifecycle.test.js — the Pole LOD late-bind, the keydown guard, the
// module-load handlers, the teardown order. What is left is the wiring itself:
// which closures this file hands those factories. Only a source read can see
// that, so these cases read it, and each one names the failure it prevents.
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

test('the param writer and the switch coordinator own the notice separately', () => {
  const consequence = 'both announce through the one notice element, so each '
    + 'must tag its writes with an owner of its own; sharing a tag lets a slider '
    + 'nudge clear a switch rejection';
  assert.match(SOURCE, /applyNotice\.show\(message, PARAM_NOTICE\)/, consequence);
  assert.match(SOURCE, /applyNotice\.show\(null, PARAM_NOTICE\)/, consequence);
  assert.match(SOURCE, /showNotice:\s*\(message\)\s*=>\s*applyNotice\.show\(message, SWITCH_NOTICE\)/,
    consequence);
  assert.notEqual(
    SOURCE.match(/PARAM_NOTICE = '([^']*)'/)?.[1],
    SOURCE.match(/SWITCH_NOTICE = '([^']*)'/)?.[1],
    'the two owner tags must differ',
  );
});

test('a segmented-POV spawn failure is announced, not only logged', () => {
  const at = SOURCE.indexOf('function segmentedFailed(');
  assert.ok(at >= 0, 'the segmented fallback must stay a named function');
  const body = SOURCE.slice(at, SOURCE.indexOf('\n}', at));
  assert.match(body, /applyNotice\.show\(/,
    'a console-only failure is invisible: the user sees the toggle flip back '
    + 'and cannot tell it from a mis-click, and the fault banner covers only '
    + 'latched runtime faults');
  assert.match(body, /SWITCH_NOTICE/,
    'the notice must carry the switch owner tag, so a parameter write does not '
    + 'clear it');
});

test('the discard path frees an engine built after disposal', () => {
  const body = wasmReadyBlock();
  assert.match(body, /discardStartup:/,
    'a startup that loses the disposal race owns everything it built; dispose() '
    + 'has already run and will not revisit it');
  assert.match(body, /host\.dispose\(\)/,
    'a WASM engine handle must be deleted, not merely dropped, and the release '
    + 'that deletes it is EngineHost.dispose() — the same one the page teardown '
    + 'runs, so the two paths cannot drift');
});

test('the segmented POV deep-link keys keep the names shared links carry', () => {
  const consequence = 'a deep link carries view.Segmented POV.<prop>, built from '
    + "the root namespace, the folder's display name and the bound property: "
    + 'changing any of the three silently invalidates every link already shared';
  assert.match(SOURCE, /new GUI\([^)]*,\s*'view'\)/, consequence);
  assert.match(SOURCE, /addFolder\('Segmented POV'\)/, consequence);
  for (const prop of ['segmented', 'segments']) {
    assert.match(SOURCE, new RegExp(`segFolder\\.add\\(segState, '${prop}'`),
      `${consequence}; '${prop}' must also stay deep-linked (add, not addSession)`);
  }
});

test('the segment-count control marks the count no hardware produces', () => {
  const at = SOURCE.indexOf("segFolder.add(segState, 'segments'");
  assert.ok(at >= 0, 'the segment-count control must stay in the segmented folder');
  assert.match(SOURCE.slice(at, SOURCE.indexOf('\n', at)), /\.name\(segLabel\)/,
    'the label must stay bound to segLabel, which carries the marker');
  assert.match(SOURCE, /segMax >= 6 \? 'Segments \(6[^']*'/,
    'the slider offers 6 segments, which the power-of-two firmware layout never '
    + 'runs; without the marker the per-segment overlay names boards that cannot exist');
});

test('the segment-count slider carries the device cap as its own maximum', () => {
  const at = SOURCE.indexOf("segFolder.add(segState, 'segments'");
  assert.match(SOURCE.slice(at, SOURCE.indexOf('\n', at)), /'segments', 2, segMax, 2\)/,
    'the cap must bound the control itself: the deep-link hydrator clamps against '
    + "the max passed to add(), and the pool's memory cost is what it bounds");
  assert.match(SOURCE, /const segMax = maxSegmentCount\(navigator, daydream\.isMobile\)/,
    'the cap must read the device hints, not a constant');
  assert.match(SOURCE, /segments: Math\.min\(segments\.count, segMax\)/,
    'the initial value must sit inside the range, or a capped device opens the '
    + 'GUI showing a count the slider cannot represent');
});

test('the late-bound engine controls are re-applied once the engine exists', () => {
  assert.match(wasmReadyBlock(), /poleLod\.replay\(\)/,
    'the Pole LOD onChange runs while host.engine is null, so the block that '
    + 'builds the engine must replay the binding; without it a ?view.poleLod '
    + 'deep link shows in the GUI but never reaches the engine');
});
