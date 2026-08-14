//
// daydream.js is the app's composition root. Its assembly is executed in
// tests/daydream_start.test.js, which drives start(deps) against fakes, and the
// factories it composes are driven in tests/app_lifecycle.test.js — the Pole LOD
// late-bind, the keydown guard, the module-load handlers, the teardown order.
// What is left here is which closure the root hands each factory: a value only a
// source read can see, so these cases read it, and each names the failure it
// prevents.
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
 * Slices from `at` to the first `sentinel` after it, asserting the sentinel is
 * present so a drifted terminator fails instead of widening the window.
 * @param {number} at - Start index.
 * @param {string} sentinel - Terminator text, excluded from the slice.
 * @returns {string} The block text.
 */
function sliceTo(at, sentinel) {
  const end = SOURCE.indexOf(sentinel, at);
  assert.ok(end > at, `daydream.js: no ${JSON.stringify(sentinel)} after index ${at}`);
  return SOURCE.slice(at, end);
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

test('the page-failure surface is the shared one, and it is torn down', () => {
  assert.match(SOURCE, /reportPageFailures\('simulator', win\)/,
    'a synchronous throw from an animation frame, a lil-gui onChange, or a DOM '
    + 'listener is console-only without the error listener the shared surface '
    + 'installs alongside the rejection one');
  const at = SOURCE.indexOf('appTeardown = createAppTeardown(');
  const args = balanced(SOURCE, SOURCE.indexOf('(', at));
  assert.match(args, /\.\.\.pageFailureListeners/,
    'a listener that outlives the page discard reports into a dead app');
});

test('the composition root rejects a stale segmented-controller module', () => {
  assert.match(SOURCE, /SEGMENT_CONTROLLER_API_VERSION/,
    'a fresh daydream.js must require a named export absent from stale cached controllers');
  assert.match(SOURCE,
    /SEGMENT_CONTROLLER_API_VERSION !== EXPECTED_SEGMENT_CONTROLLER_API_VERSION/,
    'a controller from a different API generation must fail inside bootstrap');
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
  const at = SOURCE.indexOf('createSegmentedFallback(');
  assert.ok(at >= 0, 'the segmented fallback must stay wired to its factory');
  const args = balanced(SOURCE, SOURCE.indexOf('(', at));
  assert.match(args, /showNotice:\s*\(message\)\s*=>\s*applyNotice\.show\(message, SWITCH_NOTICE\)/,
    'a console-only failure is invisible: the user sees the toggle flip back '
    + 'and cannot tell it from a mis-click, the fault banner covers only latched '
    + 'runtime faults, and the switch owner tag is what keeps a parameter write '
    + 'from clearing the notice');
  assert.match(args, /showToggle:\s*\(on\)\s*=>\s*segEnabledCtrl\.setValue\(on\)/,
    'setValue (not updateDisplay) is what makes the deep-link writer drop '
    + 'segmented=true from the URL');
});

test('a recording start or stop is announced, not only styled', () => {
  const at = SOURCE.indexOf('const recordState = {');
  assert.ok(at >= 0, 'the record toggle must stay a named binding');
  const body = sliceTo(at, '\n  }};');
  assert.match(body, /RECORD_NOTICE/,
    'the canvas tint, the duration readout, and the button label are all '
    + 'visual: without a notice a screen-reader user gets no report that the '
    + 'session started or ended');
  assert.match(body, /Recording started\./);
  assert.match(body, /Recording stopped\./);
  assert.match(body, /!wasRecording && !isRecording/,
    'a start that never began a session has already reported why through '
    + 'onError, and the generic stop message carries the same owner tag, so '
    + 'writing it here replaces the only explanation the user was given with '
    + 'one that is also untrue');
});

test('a recorder fault reports its reason, not just an un-tinted canvas', () => {
  const at = SOURCE.indexOf('host.recorder.onError =');
  assert.ok(at >= 0, 'the recorder fault hook must stay wired');
  const body = sliceTo(at, '\n      };');
  assert.match(body, /\(err\)/,
    'the hook is handed the reason; dropping the parameter throws it away');
  assert.match(body, /applyNotice\.show\([^;]*RECORD_NOTICE\)/,
    'an encoder fault, a failed start, and a cancelled Save dialog all reach '
    + 'the user as the Record button flicking back, which reads as a mis-click '
    + 'unless the reason is announced');
  assert.match(body, /showRecording\(false\)/,
    'the session is already gone: the button must stop offering to stop it');
  assert.match(body, /failed to start/,
    'the hook also fires for a start that never produced a session, where '
    + '"Recording stopped" names something that never happened');
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
  assert.match(SOURCE, /createGui\([^)]*,\s*'view'\)/, consequence);
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
  assert.match(SOURCE, /const segMax = maxSegmentCount\(nav, daydream\.isMobile\)/,
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

test('narrowing the resolution options rebinds the controller and its handler', () => {
  const consequence = "lil-gui's options() destroys the receiver and returns a "
    + 'replacement that carries the name but no onChange; syncResolutionOptions '
    + 'runs on every boot, so a discarded return value leaves the live dropdown '
    + 'writing to nothing and setValue() updating a detached <select>';
  assert.match(SOURCE, /let resolutionController/, consequence);
  assert.match(SOURCE, /resolutionController = resolutionController\.options\([^)]*\)\s*\.onChange\(setResolution\)/,
    consequence);
  assert.match(SOURCE, /const setResolution = \(v\) => appState\.set\('resolution', v\)/,
    'the replacement must re-attach the same handler the original carried, or '
    + 'the dropdown and the muted engine correction diverge');
});
