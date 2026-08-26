import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxOf, centre, checks, dragBetween, runProbe, walkTo }
  from '../scripts/probe_harness.mjs';

const PROBES = [
  ['workbench-probe.mjs', 'probeStrip'],
  ['panel-probe.mjs', 'probePanel'],
  ['solids-probe.mjs', 'probeChain'],
  ['palettes-probe.mjs', 'probeColorStrip'],
  ['mobius-probe.mjs', 'probePad'],
  ['lissajous-probe.mjs', 'probeRationalLock'],
];

test('headless probes retain page errors raised during interactions', () => {
  for (const [file, interaction] of PROBES) {
    const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8')
      .replaceAll('\r\n', '\n');
    assert.match(source, /^await runProbe\(\{$/m, file);
    assert.match(source,
      new RegExp(`failures\\.push\\(\\.\\.\\.await ${interaction}\\(tab\\)\\);`), file);
    assert.doesNotMatch(source, /failures = \[\.\.\.failures/, file);
  }
});

test('the probe harness exports the scaffolding every probe runs on', () => {
  for (const [name, exported] of Object.entries(
    { runProbe, checks, boxOf, centre, dragBetween, walkTo })) {
    assert.equal(typeof exported, 'function', name);
  }
});

test('the panel probe identifies focus through the lil-gui number controller', () => {
  const source = readFileSync(
    new URL('../scripts/panel-probe.mjs', import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n');

  assert.match(source, /querySelectorAll\('\.lil-controller\.lil-number'\)/);
  assert.match(source, /querySelector\('\.lil-name'\)/);
  assert.doesNotMatch(source, /closest\('\.controller'\)|querySelector\('\.name'\)/);
  assert.doesNotMatch(source, /widget\.textContent/);
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
