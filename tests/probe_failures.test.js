import { closeProbeResources, checks, collectProblems, describeProbeFailure, isMain, measureChecks } from '../scripts/probe_harness.mjs';
import { feedbackAtClick, probeColorStrip, probeHueWheel, probeEffectRecipeArrows, rgbMovedTogether } from '../scripts/palettes-probe.mjs';
import { readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { installConsoleCapture } from './helpers/fake_console.js';
beforeEach((t) => {
  const capture = installConsoleCapture('log');
  t.after(capture.restore);
});
import { runWorkbenchSections, probeSphericalSources, probeColorStageDrag, probeColorCard, probePaletteAndModulations, probeNoiseScaleDrag, probeDocumentActions, probeSnapshotImport, probeParity, probeStartupPersistence, probeStrip, probeStripHistory } from '../scripts/workbench-probe.mjs';
import { probeHistoryRestore, probeRationalLock } from '../scripts/lissajous-probe.mjs';
import {
  probeNumericRange, probeKeyboardEdits, probeMobilePanel, probePanel, probePresetName, probeSidebar, probeSliderDrag,
  probeStageNames, probeTelemetry, probeTouchSlider, probeWarningNote,
} from '../scripts/panel-probe.mjs';
import { probeChain, probeNumericInputs } from '../scripts/solids-probe.mjs';
import { probePad } from '../scripts/mobius-probe.mjs';
import { scratchDir } from './helpers/fixture_repo.js';
import { stashGlobals } from './helpers/fake_dom.js';

const PROBES = [
  ['workbench-probe.mjs', 'probeSphericalSources', probeSphericalSources],
  ['workbench-probe.mjs', 'probeColorStageDrag', probeColorStageDrag],
  ['workbench-probe.mjs', 'probeColorCard', probeColorCard],
  ['workbench-probe.mjs', 'probePaletteAndModulations', probePaletteAndModulations],
  ['workbench-probe.mjs', 'probeNoiseScaleDrag', probeNoiseScaleDrag],
  ['workbench-probe.mjs', 'probeDocumentActions', probeDocumentActions],
  ['workbench-probe.mjs', 'probeParity', probeParity],
  ['workbench-probe.mjs', 'probeStripHistory', probeStripHistory],
  ['workbench-probe.mjs', 'probeSnapshotImport', probeSnapshotImport],
  ['workbench-probe.mjs', 'probeStartupPersistence', probeStartupPersistence],

  ['palettes-probe.mjs', 'probeHueWheel', probeHueWheel],
  ['palettes-probe.mjs', 'probeEffectRecipeArrows', probeEffectRecipeArrows],

  ['lissajous-probe.mjs', 'probeHistoryRestore', probeHistoryRestore],

  ['panel-probe.mjs', 'probeSliderDrag', probeSliderDrag],
  ['panel-probe.mjs', 'probeKeyboardEdits', probeKeyboardEdits],
  ['panel-probe.mjs', 'probeNumericRange', probeNumericRange],
  ['panel-probe.mjs', 'probeTouchSlider', probeTouchSlider],
  ['panel-probe.mjs', 'probePresetName', probePresetName],
  ['panel-probe.mjs', 'probeMobilePanel', probeMobilePanel],
  ['panel-probe.mjs', 'probeSidebar', probeSidebar],
  ['panel-probe.mjs', 'probeWarningNote', probeWarningNote],
  ['panel-probe.mjs', 'probeStageNames', probeStageNames],
  ['panel-probe.mjs', 'probeTelemetry', probeTelemetry],

  ['workbench-probe.mjs', 'probeStrip', probeStrip],
  ['panel-probe.mjs', 'probePanel', probePanel],
  ['solids-probe.mjs', 'probeChain', probeChain],
  ['solids-probe.mjs', 'probeNumericInputs', probeNumericInputs],
  ['palettes-probe.mjs', 'probeColorStrip', probeColorStrip],
  ['mobius-probe.mjs', 'probePad', probePad],
  ['lissajous-probe.mjs', 'probeRationalLock', probeRationalLock],
];

test('isMain recognizes an entry module reached through a junction', (t) => {
  const temp = scratchDir(t, 'probe-entry-');
  const original = process.argv[1];
  t.after(() => {
    process.argv[1] = original;
  });
  const scripts = fileURLToPath(new URL('../scripts', import.meta.url));
  symlinkSync(scripts, join(temp, 'scripts'), 'junction');
  process.argv[1] = join(temp, 'scripts', 'panel-probe.mjs');
  assert.equal(isMain(pathToFileURL(join(scripts, 'panel-probe.mjs')).href), true);
});

/** The message a stubbed-out tab raises on the first call the probe makes. */
const REFUSAL = 'the page went away mid-interaction';

/**
 * A tab that answers every call by throwing, so an interaction cannot reach a
 * verdict without the failure escaping it.
 * @returns {{tab: object, calls: string[]}} The stand-in and the calls it saw.
 */
function throwingTab() {
  /** @type {string[]} */
  const calls = [];
  const tab = new Proxy({}, {
    get(target, property) {
      if (property === 'then') return undefined; // not a thenable
      if (property === 'mouse' || property === 'keyboard') return tab;
      return () => {
        calls.push(String(property));
        throw new Error(REFUSAL);
      };
    },
  });
  return { tab, calls };
}

test('checks() keeps the misses and drops the passes', () => {
  const { failures, check } = checks();
  check(true, 'a pass is not a failure');
  check(false, 'a miss is kept verbatim');
  check(false, 'and so is the next one');
  assert.deepEqual(failures, ['a miss is kept verbatim', 'and so is the next one']);
});

test('probe diagnostics retain the failure phase and compact page state', async (t) => {
  t.after(stashGlobals('document', 'location', 'window', 'performance'));
  const elements = new Map([
    ['loading-overlay', {textContent: 'Loading engine'}],
    ['shader-document-status', {textContent: 'Source catalog failed', dataset: {status: 'error'}}],
    ['shader-document-error', {textContent: 'x'.repeat(400)}],
    ['gui-container', {children: [{}]}],
  ]);
  Object.assign(globalThis, {
    document: {
      readyState: 'complete', visibilityState: 'hidden', hasFocus: () => false,
      getElementById: (id) => elements.get(id),
      querySelectorAll: (selector) => selector === 'canvas'
        ? [{width: 960, height: 540, clientWidth: 480, clientHeight: 270}]
        : Array.from({length: 20}, (_, index) => ({dataset: {label: `stage${index}`}})),
      querySelector: (selector) => selector === '.global-gui' ? {children: [{}, {}]} : {disabled: true},
    },
    location: {pathname: '/tools/shader.html', hash: '#shader=v2.' + 'a'.repeat(500)},
    window: {daydreamSmokeDraws: 2, daydreamSmokeGlDraws: 1, daydreamSmokeGlPixels: false},
    performance: {getEntriesByType: () => Array.from({length: 24}, (_, index) => ({
      name: `http://localhost/generated/module${index}.js?hash=secret#fragment`,
      duration: 3.6, transferSize: 120, initiatorType: 'script',
    }))},
  });
  const tab = {evaluate: async (capture) => capture()};
  const message = await describeProbeFailure(tab, 'document chips', new Error('Waiting failed: 90000ms'));
  assert.match(message, /^document chips: Waiting failed: 90000ms; state=/);
  const state = JSON.parse(message.split('; state=')[1]);
  assert.equal(state.path, '/tools/shader.html');
  assert.equal(state.visibility, 'hidden');
  assert.equal(state.overlay, 'Loading engine');
  assert.equal(state.statusKind, 'error');
  assert.equal(state.error.length, 240);
  assert.equal(state.chips.length, 16);
  assert.equal(state.undoDisabled, true);
  assert.equal(state.hash.length, 24);
  assert.equal(state.hashLength, 511);
  assert.equal(state.draws, 2);
  assert.equal(state.glPixels, false);
  assert.equal(state.guiChildren, 1);
  assert.equal(state.globalGuiChildren, 2);
  assert.deepEqual(state.canvases, [{width: 960, height: 540, clientWidth: 480, clientHeight: 270}]);
  assert.equal(state.resources.length, 20);
  assert.deepEqual(state.resources[0], {path: '/generated/module4.js', duration: 4, transfer: 120, type: 'script'});
  assert.doesNotMatch(message, /secret|localhost/);
});

test('probe diagnostics preserve the original failure when page capture rejects', async () => {
  const tab = {evaluate: async () => {throw new Error('Target closed');}};
  assert.match(await describeProbeFailure(tab, 'Twist angle undo digest', 'Waiting failed'),
    /Twist angle undo digest: Waiting failed; state=\{"capture":"page state unavailable: Target closed"/);
});

test('probe diagnostics handle a page with no mounted controls or draw probe', async (t) => {
  t.after(stashGlobals('document', 'location', 'window'));
  Object.assign(globalThis, {
    document: {
      readyState: 'loading', visibilityState: 'visible', hasFocus: () => true,
      getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
    },
    location: {pathname: '/tools/shader.html', hash: ''}, window: {},
  });
  const message = await describeProbeFailure({evaluate: async (capture) => capture()},
    'engine overlay', new Error('Waiting failed'));
  const state = JSON.parse(message.split('; state=')[1]);
  assert.equal(state.ready, 'loading');
  for (const key of ['overlay', 'status', 'statusKind', 'error', 'undoDisabled', 'draws', 'glDraws', 'glPixels'])
    assert.equal(state[key], null, key);
  assert.deepEqual(state.chips, []);
  assert.match(await describeProbeFailure(undefined, 'navigation', 'Navigation failed'),
    /navigation: Navigation failed; state=\{"capture":"page state unavailable: page was not opened"/);
});

test('probe diagnostics finish when the renderer does not answer', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const tab = {evaluate: () => new Promise(() => {})};
  const pending = describeProbeFailure(tab, 'canvas draw', new Error('Waiting failed'));
  t.mock.timers.tick(1000);
  assert.match(await pending, /canvas draw: Waiting failed; state=\{"capture":"page state timed out after 1000ms"/);
});

test('probe diagnostics track pending requests by identity and clear completed and failed requests', async () => {
  const listeners = new Map();
  const tab = {on: (name, handler) => listeners.set(name, handler), evaluate: async () => ({})};
  const problems = [];
  collectProblems(tab, 'http://localhost/daydream', problems);
  const request = () => ({url: () => 'http://localhost/daydream/app.js?token=secret',
    failure: () => ({errorText: 'aborted'})});
  const first = request();
  const second = request();
  listeners.get('request')(first);
  listeners.get('request')(second);
  listeners.get('requestfinished')(first);
  const state = async () => JSON.parse((await describeProbeFailure(tab, 'engine overlay', 'Waiting failed'))
    .split('; state=')[1]);
  assert.deepEqual((await state()).pendingRequests, ['/daydream/app.js']);
  listeners.get('requestfailed')(second);
  assert.deepEqual((await state()).pendingRequests, []);
  assert.equal(problems.length, 1);
  for (let index = 0; index < 24; index++) listeners.get('request')(request());
  assert.equal((await state()).pendingRequests.length, 20);
  const other = {evaluate: async () => ({})};
  assert.deepEqual(JSON.parse((await describeProbeFailure(other, 'engine overlay', 'Waiting failed'))
    .split('; state=')[1]).pendingRequests, []);
});

test('the solids probe rejects an incomplete operation chain', async () => {
  const clicks = [];
  const media = [];
  const tab = {
    async $eval(selector) {
      if (selector === '#labels') return 'true';
      if (selector === '#arenaStats') return 'Live 1 Scratch A 2 Scratch B 3';
      if (selector === '#toggleRotate') {
        return clicks.includes(selector) ? 'true' : { checked: 'false', transition: '0s' };
      }
      if (selector === '#meshStats') return 'mesh';
      assert.fail(`unexpected selector: ${selector}`);
    },
    async click(selector) { clicks.push(selector); },
    async emulateMediaFeatures(features) { media.push(features); },
    async waitForSelector() {},
    async waitForFunction() {},
    async $$eval(selector) {
      assert.equal(selector, '#opsList .op-item .font-bold');
      return ['KIS', 'AMBO'];
    },
  };
  const failures = await probeChain(tab);
  assert.deepEqual(failures, ['the chain builds as KIS, AMBO']);
  assert.deepEqual(clicks, [
    '#toggleRotate', '#addOpGrid [data-op="kis"]',
    '#addOpGrid [data-op="ambo"]', '#addOpGrid [data-op="dual"]',
  ]);
  assert.deepEqual(media, [[{ name: 'prefers-reduced-motion', value: 'no-preference' }]]);
});

// A tab that refuses every call must surface as a thrown refusal, never as an
// empty verdict.
for (const [file, name, interaction] of PROBES) {
  test(`${name} drives the page and lets a refusal escape`, async () => {
    const { tab, calls } = throwingTab();
    await assert.rejects(() => interaction(tab), (error) => {
      assert.match(String(error.message), new RegExp(REFUSAL));
      return true;
    }, `${file}: ${name} swallowed a refusing page`);
    assert.ok(calls.length > 0, `${file}: ${name} never touched the tab`);
  });
}

test('a probe module is inert until node is pointed at it', () => {
  const modules = scriptModules();
  for (const file of new Set(PROBES.map(([file]) => file))) {
    const source = modules.get(file);
    assert.match(source, /^if \(isMain\(import\.meta\.url\)\) await runProbe\(/m, file);
    assert.equal([...source.matchAll(/\brunProbe\s*\(/g)].length, 1,
      `${file} has an additional browser launch`);
  }
  assert.equal(isMain(import.meta.url), true);
});

/** @returns {Map<string, string>} Every scripts/*.mjs module, by file name. */
function scriptModules() {
  const directory = fileURLToPath(new URL('../scripts', import.meta.url));
  return new Map(readdirSync(directory)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => [name, readFileSync(join(directory, name), 'utf8')]));
}

/**
 * @param {Map<string, string>} modules - The scripts/ module set.
 * @returns {string[]} The ones node is pointed at to drive a browser.
 * @details A script that imports probe_harness.mjs and that no other script
 *   imports is an entry point.
 */
function browserEntryPoints(modules) {
  const imported = new Set();
  for (const source of modules.values()) {
    for (const match of source.matchAll(/from '\.\/([^']+\.mjs)'/g)) imported.add(match[1]);
  }
  return [...modules]
    .filter(([name, source]) =>
      source.includes("from './probe_harness.mjs'") && !imported.has(name))
    .map(([name]) => name);
}

test('every script that drives a browser is wired into the paired CI suite', () => {
  const driven = browserEntryPoints(scriptModules());
  assert.ok(driven.includes('browser-smoke.mjs'),
    'the page smoke reads as scaffolding rather than as a browser entry point');
  assert.equal(driven.length, new Set(PROBES.map(([file]) => file)).size + 1,
    `the browser entry points are ${driven.join(', ')}`);
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const workflow = read('../.github/workflows/browser-smoke.yml');
  for (const file of driven) {
    assert.ok(workflow.includes(`scripts/${file}`)
      || (file.endsWith('-probe.mjs') && workflow.includes('scripts/*-probe.mjs')),
      `${file} is missing from .github/workflows/browser-smoke.yml`);
  }
});

test('PROBES names every scripts/*-probe.mjs and no others', () => {
  const probes = [...scriptModules().keys()].filter((name) => name.endsWith('-probe.mjs'));
  assert.ok(probes.length > 0, 'the probe glob matched nothing');
  assert.deepEqual(probes.sort(),
    [...new Set(PROBES.map(([file]) => file))].sort());
});

test('PROBES names every exported probe interaction and no others', async () => {
  const files = [...new Set(PROBES.map(([file]) => file))];
  for (const file of files) {
    const module = await import(new URL(`../scripts/${file}`, import.meta.url));
    const exported = Object.keys(module).filter((name) => name.startsWith('probe')).sort();
    const listed = PROBES
      .filter(([listedFile]) => listedFile === file)
      .map(([, name]) => name)
      .sort();
    assert.deepEqual(listed, exported, `${file} probe exports and PROBES drifted`);
  }
});

test('probe counts include passes and failures and enforce a nonzero floor', async () => {
  const empty = await measureChecks(async () => [], 2);
  assert.equal(empty.count, 0);
  assert.match(empty.failures[0], /only 0 checks executed/);
  const measured = await measureChecks(async () => {
    const verdict = checks();
    verdict.check(true, 'pass');
    verdict.check(false, 'failure');
    assert.equal(verdict.count, 2);
    return verdict.failures;
  }, 2);
  assert.deepEqual(measured, { count: 2, failures: ['failure'] });
  const partial = await measureChecks(async () => {
    const verdict = checks();
    verdict.check(true, 'pass');
    return verdict.failures;
  }, 2);
  assert.match(partial.failures[0], /only 1 checks executed/);
  await assert.rejects(() => measureChecks(async () => [], 0), /positive integer/);
});

test('the panel probe rejects a layout with no scrollable overflow', async () => {
  const failures = await probePanel({
    waitForSelector: async () => ({ click: async () => {} }),
    waitForFunction: async () => {},
    $eval: async () => ({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 }),
  });
  assert.ok(failures.some((message) => /overflows its height cap/.test(message)));
});

test('the pad probe rejects wrong geometry and a pointer that never moves its value', async () => {
  const tab = {
    select: async () => {}, waitForFunction: async () => {},
    waitForSelector: async () => ({
      boundingBox: async () => ({ x: 0, y: 0, width: 0, height: 0 }),
    }),
    mouse: { move: async () => {}, down: async () => {}, up: async () => {}, click: async () => {} },
    $eval: async (selector, callback) => selector === '#parameters' ? callback({
      getBoundingClientRect: () => ({bottom:100}), querySelectorAll: () => [90, 110].map(bottom => ({
        getBoundingClientRect: () => ({bottom})})),
    }) : false,
    $$eval: async () => 1,
    evaluate: async () => ({ re: '0.00', im: '0.00', left: '0%', top: '0%', label: '' }),
  };
  const failures = await probePad(tab);
  assert.ok(failures.some((message) => /pad lays out 0x0/.test(message)));
  assert.ok(failures.some((message) => /the press reads/.test(message)));
  assert.ok(failures.some((message) => /the drag tracks/.test(message)));
});

test('RGB lock checks reject missing, incomplete, nonfinite, and unmoved channels', () => {
  for (const [before, after] of [
    [[], []], [[1], [2]], [[1, 2, 3], []], [[1, 2, 3], [2, 3]],
    [[NaN, 2, 3], [2, 3, 4]], [[1, 2, 3], [Infinity, 3, 4]],
    [[1, 2, 3], [1, 2, 3]], [[1, 2, 3], [2, 4, 4]],
  ]) assert.equal(rgbMovedTogether(before, after), false);
  assert.equal(rgbMovedTogether([1, 2, 3], [2, 3, 4]), true);
});

test('copy feedback geometry rejects shifts and missing bounds', () => {
  const box = { left: 450, top: 248, width: 100, height: 40, gap: 12 };
  const click = { x: 500, y: 300 };
  assert.equal(feedbackAtClick(box, click), true);
  for (const wrong of [{ left: 460 }, { top: 258 }, { width: 0 }, { height: 0 }, { left: NaN }]) {
    assert.equal(feedbackAtClick({ ...box, ...wrong }, click), false);
  }
});

test('probe teardown preserves failures and attempts every close', async () => {
  const failures = ['the slider did not move'];
  let closedSite = false;
  await closeProbeResources({ close: async () => { throw new Error('Target closed'); } },
    { close: async () => { closedSite = true; throw new Error('site close failed'); } }, failures);
  assert.equal(closedSite, true);
  assert.deepEqual(failures, ['the slider did not move',
    'browser teardown: Target closed', 'site teardown: site close failed']);
});

test('the preset name probe detaches on a missing control and on CDP failure', async () => {
  for (const reject of [false, true]) {
    let detached = 0;
    const tab = { createCDPSession: async () => ({
      send: async (method) => {
        if (reject) throw new Error('CDP failed');
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 0 };
      },
      detach: async () => { detached++; },
    }) };
    if (reject) await assert.rejects(() => probePresetName(tab), /CDP failed/);
    else assert.equal((await probePresetName(tab)).length, 1);
    assert.equal(detached, 1);
  }
});

test('workbench sections continue after interaction and close failures', async () => {
  const visited = [];
  let closed = 0;
  const failures = await runWorkbenchSections(async () => ({
    waitForFunction: async () => {}, waitForSelector: async () => {},
    close: async () => { closed++; if (closed === 1) throw new Error('close failed'); },
  }), [
    async function first() { visited.push('first'); throw new Error('timed out'); },
    async function second() { visited.push('second'); return ['assertion failed']; },
  ]);
  assert.deepEqual(visited, ['first', 'second']);
  assert.equal(closed, 2);
  assert.equal(failures.length, 3);
  assert.match(failures[0], /first: interaction: timed out/);
  assert.match(failures[1], /first close:.*close failed/);
  assert.equal(failures[2], 'assertion failed');
});

test('workbench readiness failures identify overlay and document stages before interactions', async () => {
  for (const phase of ['engine overlay', 'document chips']) {
    let interacted = false;
    let closed = false;
    const fail = async () => {throw new Error('Waiting failed');};
    const failures = await runWorkbenchSections(async () => ({
      waitForFunction: phase === 'engine overlay' ? fail : async () => {},
      waitForSelector: fail,
      evaluate: async () => ({overlay: phase === 'engine overlay' ? 'Loading' : null}),
      close: async () => {closed = true;},
    }), [async function documentActions() {interacted = true; return [];}]);
    assert.equal(interacted, false);
    assert.equal(closed, true);
    assert.equal(failures.length, 1);
    assert.match(failures[0], new RegExp(`documentActions: ${phase}: Waiting failed; state=`));
  }
});

test('workbench startup holds only the catalog request and releases it before teardown', async () => {
  const events = [];
  let requestHandler;
  let catalogRequest;
  const tab = {
    setRequestInterception: async (enabled) => { assert.equal(enabled, true); },
    on: (event, handler) => { assert.equal(event, 'request'); requestHandler = handler; },
    waitForFunction: async () => {},
    waitForSelector: async () => { await catalogRequest; events.push('ready'); },
    evaluate: async () => { events.push('defaults checked'); return true; },
    $eval: async () => true,
    close: async () => { events.push('closed'); },
  };
  const failures = await runWorkbenchSections(async ({ prepare }) => {
    await prepare(tab);
    await requestHandler({
      url: () => 'http://localhost/tools/shader.css',
      continue: async () => { events.push('stylesheet'); },
    });
    catalogRequest = requestHandler({
      url: () => 'http://localhost/generated/shader/engine_catalog.json',
      continue: async () => { events.push('catalog'); },
    });
    assert.deepEqual(events, ['stylesheet']);
    return tab;
  }, [probeStartupPersistence]);
  assert.deepEqual(failures, []);
  assert.deepEqual(events, ['stylesheet', 'defaults checked', 'catalog', 'ready', 'closed']);
});

test('the parity probe reports a compiled preset refusal after a successful document load', async () => {
  const selectors = [];
  const sources = [];
  let parityReads = 0;
  const failures = await probeParity({
    select: async (selector, value) => {
      assert.equal(selector, '#shader-document-select');
      sources.push(value);
    },
    waitForFunction: async () => {},
    waitForSelector: async (selector) => ({ click: async () => { selectors.push(selector); } }),
    $: async () => ({}),
    $eval: async (selector) => selector === '#shader-parity-toggle'
      ? (++parityReads === 1 ? true : { armed: true, status: 'ok' })
      : { status: 'error', text: 'unknown parameter' },
  });
  assert.deepEqual(sources, ['ash-cloud', 'alien-core']);
  assert.deepEqual(selectors, ['#shader-parity-toggle']);
  assert.deepEqual(failures, ['the compiled build takes every authored value (unknown parameter)']);
});


test('palette and modulation probe reports a family whose controls fail to appear', async () => {
  for (const broken of [false, true]) {
    let family = 'cycling-generated';
    let stages = [];
    let disabled = null;
    const amounts = new Map();
    const tab = {
      select: async (selector, value) => { if (selector.includes('palette-type')) family = value; },
      waitForFunction: async (callback, options, label) => {
        if (label === undefined) return undefined;
        assert.equal(label, disabled);
        return {jsonValue: async () => ({
          document: {descriptor: {chain: stages}},
          chainSnapshot: {modulation: stages.map((entry) => ({
            instance: entry.label,
            recipe: {enabled: entry.label !== disabled, mechanic: {amount: amounts.get(entry.label)}},
          }))},
        })};
      },
      waitForSelector: async () => ({click: async () => {}}),
      $: async (selector) => selector.includes('colorize') || stages.some((entry) => selector.includes(entry.label)) ? {} : null,
      async $eval(selector, callback, ...args) {
        if (selector === '#shader-document-status') return callback({dataset: {status: 'ok'}});
        if (selector.endsWith(']') && selector.includes('data-label="stage')) {
          stages = [stages[1], stages[0], stages[2]];
          return;
        }
        if (selector.includes('.chain-band-add')) {
          stages.push({label: `stage${stages.length + 1}`, operator: 'color.modulate.v1'});
          return;
        }
        const label = selector.match(/data-label="([^"]+)"/)?.[1];
        if (selector.includes('.chain-modulation-enabled')) disabled = label;
        if (selector.includes('.chain-chip-remove')) stages = stages.filter((entry) => entry.label !== label);
        const parameterLabel = selector.match(/data-parameter="([^.]+)\.modulation-amount"/)?.[1];
        if (selector.includes('.chain-param-value') && parameterLabel) {
          const input = {value: '', dispatchEvent() { amounts.set(parameterLabel, Number(this.value)); }};
          return callback(input, ...args);
        }
        const field = selector.match(/data-parameter="colorize.([^"]+)"/)?.[1];
        const visible = {
          generated: ['palette-harmony'], procedural: ['palette-name'], gradient: ['gradient-start-r'],
          mutating: ['palette-name-b'], 'cycling-generated': ['palette-mode'],
        }[family];
        return callback({hidden: !visible.includes(field) || (broken && family === 'generated'),
          click() {}, dispatchEvent() {}}, ...args);
      },
      async $$eval(selector, callback) {
        return callback(selector.includes('option') ? Array.from({length: selector.includes('harmony') ? 8 : 27})
          : stages.map((entry) => ({dataset: {label: entry.label}})));
      },
      async evaluate(callback) {
        if (String(callback).includes('Promise.all'))
          return JSON.stringify({descriptor: {chain: stages.filter((entry) => entry.label !== disabled)}});
      },
    };
    const failures = await probePaletteAndModulations(tab);
    assert.deepEqual(failures, broken
      ? ['generated reveals its own palette controls and reaches the live engine'] : []);
  }
});


for (const broken of [false, true]) test(`effect-recipe probe detects repeated arrows and stale placeholder=${broken}`, async () => {
  let index = -1;
  const values = broken ? ['0', '0', '1'] : ['0', '1', ''];
  const failures = await probeEffectRecipeArrows({focus: async () => {},
    keyboard: {press: async () => { index++; }},
    $eval: async (selector, read) => read({value: values[index]})});
  assert.equal(failures.length, broken ? 2 : 0);
});

for (const missing of [false, true]) test(`numeric range probe checks exact accessibility node with missing=${missing}`, async () => {
  let detached = false;
  const failures = await probeNumericRange({evaluate: async () => {}, waitForSelector: async () => {},
    focus: async () => {}, $eval: async () => {}, createCDPSession: async () => ({
      send: async command => command === 'DOM.getDocument' ? {root:{nodeId:1}}
        : command === 'DOM.querySelector' ? {nodeId:2}
        : {nodes: missing ? [] : [{role:{value:'textbox'},value:{value:'0.750'},description:{value:'Range -1 to 1.'}}]},
      detach: async () => { detached = true; },
    })});
  assert.equal(failures.length, missing ? 2 : 0);
  assert.equal(detached, true);
});
