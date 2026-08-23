import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const text = (path) => readFileSync(path, 'utf8');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('the committed WASM artifacts match their recorded hashes', () => {
  const entries = text('holosphere_wasm.wasm.sha256')
    .trim().split(/\r?\n/)
    .map((line) => line.match(/^([0-9a-f]{64})\s+\*?(.+)$/));
  assert.ok(entries.length >= 2);
  for (const entry of entries) {
    assert.ok(entry, 'each checksum line has sha256sum syntax');
    assert.equal(sha256(entry[2]), entry[1], entry[2]);
  }
});

test('the engine pin is one clean full commit', () => {
  assert.match(text('holosphere_wasm.sha').trim(), /^[0-9a-f]{40}$/);
});

test('the toolchain record describes a release module', () => {
  const fields = Object.fromEntries(
    text('holosphere_wasm.toolchain').trim().split(/\r?\n/).map((line) => line.split(/\s+/, 2)),
  );
  assert.match(fields.emsdk, /^\d+\.\d+\.\d+$/);
  assert.equal(fields.build_type, 'Release');
  assert.equal(fields.dev_bindings, 'OFF');
});

test('deploy consumes one checksummed engine bundle at the module pin', () => {
  const workflow = text('.github/workflows/deploy.yml');
  assert.match(workflow, /holosphere-engine-\$PIN/);
  assert.match(workflow, /sha256sum -c holosphere_engine\.sha256/);
  assert.match(workflow, /cmp -s "engine-bundle\/\$path" "\$path"/);
  assert.doesNotMatch(workflow, /cmake --build|path: engine/);
});

test('deploy stops waiting when the pinned engine run cannot publish', () => {
  const workflow = text('.github/workflows/deploy.yml');
  assert.match(workflow, /if \[ "\$run_status" = completed \]/);
  assert.match(workflow, /POV CI for \$PIN concluded \$run_conclusion/);
  assert.match(workflow, /published no verified engine bundle/);
});

test('pre-push verifies the working-tree artifacts', () => {
  assert.match(text('.githooks/pre-push'), /DAYDREAM_WASM_CLEAN_REQUIRED=1/);
});
