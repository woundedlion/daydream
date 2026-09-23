import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxOf, centre, checks, dragBetween, isMain, measureChecks, runProbe, walkTo }
  from '../scripts/probe_harness.mjs';
import { probeDocumentActions, probeParity, probeStrip, probeStripHistory } from '../scripts/workbench-probe.mjs';
import { probeColorStrip, probeHueWheel } from '../scripts/palettes-probe.mjs';
import { probeHistoryRestore, probeRationalLock } from '../scripts/lissajous-probe.mjs';
import {
  probeMobilePanel, probePanel, probePresetName, probeSidebar, probeSliderDrag,
  probeStageNames, probeTelemetry, probeTouchSlider, probeWarningNote,
} from '../scripts/panel-probe.mjs';
import { probeChain, probeNumericInputs } from '../scripts/solids-probe.mjs';
import { probePad } from '../scripts/mobius-probe.mjs';

const PROBES = [
  ['workbench-probe.mjs', 'probeDocumentActions', probeDocumentActions],
  ['workbench-probe.mjs', 'probeParity', probeParity],
  ['workbench-probe.mjs', 'probeStripHistory', probeStripHistory],

  ['palettes-probe.mjs', 'probeHueWheel', probeHueWheel],

  ['lissajous-probe.mjs', 'probeHistoryRestore', probeHistoryRestore],

  ['panel-probe.mjs', 'probeSliderDrag', probeSliderDrag],
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
    get(_target, property) {
      if (property === 'then') return undefined; // not a thenable
      if (property === 'mouse' || property === 'keyboard') return tab;
      return (/** @type {unknown[]} */ ...args) => {
        calls.push(String(property));
        void args;
        throw new Error(REFUSAL);
      };
    },
  });
  return { tab, calls };
}

test('the probe harness exports the scaffolding every probe runs on', () => {
  for (const [name, exported] of Object.entries(
    { runProbe, checks, boxOf, centre, dragBetween, walkTo, isMain })) {
    assert.equal(typeof exported, 'function', name);
  }
});

test('checks() keeps the misses and drops the passes', () => {
  const { failures, check } = checks();
  check(true, 'a pass is not a failure');
  check(false, 'a miss is kept verbatim');
  check(false, 'and so is the next one');
  assert.deepEqual(failures, ['a miss is kept verbatim', 'and so is the next one']);
});

// The interaction is the probe: gutting one to `async () => []` has to be
// visible here, which only executing it can show. A tab that refuses every
// call must surface as a thrown refusal, never as an empty verdict.
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
  for (const [file] of PROBES) {
    const url = new URL(`../scripts/${file}`, import.meta.url).href;
    assert.equal(isMain(url), false, `${file} would have driven a browser on import`);
  }
  // argv[1] under `node --test` is this file, which is what makes the
  // guard true for a probe run directly and false for an imported one.
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
 * @details probe_harness.mjs is the browser scaffolding, so a script that takes
 *   it and that no other script imports is an entry point rather than a module
 *   of its own, and the rosters have to name it.
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

test('every script that drives a browser is wired into both rosters', () => {
  const driven = browserEntryPoints(scriptModules());
  assert.ok(driven.includes('browser-smoke.mjs'),
    'the page smoke reads as scaffolding rather than as a browser entry point');
  assert.equal(driven.length, new Set(PROBES.map(([file]) => file)).size + 1,
    `the browser entry points are ${driven.join(', ')}`);
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const workflow = read('../.github/workflows/browser-smoke.yml');
  const prePush = read('../.githooks/pre-push');
  for (const file of driven) {
    assert.ok(workflow.includes(`scripts/${file}`),
      `${file} is missing from .github/workflows/browser-smoke.yml`);
    assert.ok(prePush.includes(`node scripts/${file}`),
      `${file} is missing from .githooks/pre-push`);
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
    $eval: async () => false,
    $$eval: async () => 1,
    evaluate: async () => ({ re: '0.00', im: '0.00', left: '0%', top: '0%', label: '' }),
  };
  const failures = await probePad(tab);
  assert.ok(failures.some((message) => /pad lays out 0x0/.test(message)));
  assert.ok(failures.some((message) => /the press reads/.test(message)));
  assert.ok(failures.some((message) => /the drag tracks/.test(message)));
});
