import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxOf, centre, checks, dragBetween, isMain, runProbe, walkTo }
  from '../scripts/probe_harness.mjs';
import { probeStrip } from '../scripts/workbench-probe.mjs';
import { probePanel } from '../scripts/panel-probe.mjs';
import { probeChain } from '../scripts/solids-probe.mjs';
import { probeColorStrip } from '../scripts/palettes-probe.mjs';
import { probePad } from '../scripts/mobius-probe.mjs';
import { probeRationalLock } from '../scripts/lissajous-probe.mjs';

const PROBES = [
  ['workbench-probe.mjs', 'probeStrip', probeStrip],
  ['panel-probe.mjs', 'probePanel', probePanel],
  ['solids-probe.mjs', 'probeChain', probeChain],
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

test('every scripts/*-probe.mjs is wired into all three probe rosters', () => {
  const probes = readdirSync(fileURLToPath(new URL('../scripts', import.meta.url)))
    .filter((name) => name.endsWith('-probe.mjs'));
  assert.ok(probes.length > 0, 'the probe glob matched nothing');
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const workflow = read('../.github/workflows/browser-smoke.yml');
  const prePush = read('../.githooks/pre-push');
  const listed = PROBES.map(([file]) => file);
  for (const file of probes) {
    assert.ok(workflow.includes(`scripts/${file}`),
      `${file} is missing from .github/workflows/browser-smoke.yml`);
    assert.ok(prePush.includes(`node scripts/${file}`),
      `${file} is missing from .githooks/pre-push`);
    assert.ok(listed.includes(file), `${file} is missing from PROBES`);
  }
  for (const file of listed) {
    assert.ok(probes.includes(file), `PROBES names a missing probe "${file}"`);
  }
});
