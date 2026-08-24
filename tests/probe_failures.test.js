import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PROBES = [
  ['workbench-probe.mjs', 'probeStrip'],
  ['panel-probe.mjs', 'probePanel'],
  ['solids-probe.mjs', 'probeChain'],
];

test('headless probes retain page errors raised during interactions', () => {
  for (const [file, interaction] of PROBES) {
    const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8')
      .replaceAll('\r\n', '\n');
    assert.match(source, /^const failures = \[\];\ntry \{/m, file);
    assert.match(source,
      new RegExp(`failures\\.push\\(\\.\\.\\.await ${interaction}\\(tab\\)\\);`), file);
    assert.doesNotMatch(source, /failures = \[\.\.\.failures/, file);
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
