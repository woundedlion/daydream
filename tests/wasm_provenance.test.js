import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MORPH_SWEEP } from '../tools/solid_codegen.js';

const text = (path) => readFileSync(path, 'utf8');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const engineCandidates = process.env.HOLOSPHERE_ENGINE_DIR
  ? [resolve(process.env.HOLOSPHERE_ENGINE_DIR)]
  : ['engine', '../Holosphere', '../pov'].map((path) => resolve(path));
const engineRoot = engineCandidates.find(
  (path) => existsSync(resolve(path, 'scripts/shader_workbench.mjs')));
const engineMissing = `no Holosphere checkout found in ${engineCandidates.join(', ')}`;
const engineSkip = engineRoot || process.env.HOLOSPHERE_ENGINE_REQUIRED ? false : engineMissing;

const committed = (root, path) => execFileSync(
  'git', ['-C', root, 'show', `HEAD:${path}`], { encoding: 'buffer' });

function cppFloatConstant(source, name) {
  const match = new RegExp(
    `\\binline\\s+constexpr\\s+float\\s+${name}\\s*=\\s*` +
      '([0-9]+(?:\\.[0-9]*)?(?:[eE][+-]?[0-9]+)?f?)\\s*;',
  ).exec(source);
  assert.ok(match, `engine source does not declare literal float ${name}`);
  return Number(match[1].replace(/f$/, ''));
}

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

test('the committed shader modules match engine HEAD byte for byte', { skip: engineSkip }, () => {
  assert.ok(engineRoot, engineMissing);
  for (const name of ['shader_workbench.mjs', 'sha256.mjs']) {
    assert.deepEqual(
      committed('.', `shader/${name}`),
      committed(engineRoot, `scripts/${name}`),
      `${name} differs from engine HEAD`,
    );
  }
});

test('MORPH_SWEEP matches the engine morphability constants', { skip: engineSkip }, () => {
  assert.ok(engineRoot, engineMissing);
  const graph = committed(engineRoot, 'core/mesh/conway_graph.h').toString('utf8');
  const recipe = committed(engineRoot, 'core/mesh/recipe.h').toString('utf8');
  const truncateMin = cppFloatConstant(graph, 'T_TRUNCATE_ARRIVAL_MIN');
  const amboEpsilon = cppFloatConstant(graph, 'T_EPS_AMBO');
  const chamferMin = cppFloatConstant(graph, 'T_EPS');
  const chamferMax = cppFloatConstant(recipe, 'CHAMFER_T_MAX');

  assert.match(
    graph,
    /inline\s+constexpr\s+float\s+T_TRUNCATE_FAR_MAX\s*=\s*1\.0f\s*-\s*T_EPS_AMBO\s*;/,
    'the truncate far bound changed form; update the parity reader',
  );
  assert.match(
    recipe,
    /case Op::TRUNCATE:\s*return step\.param >= ConwayGraph::T_TRUNCATE_ARRIVAL_MIN &&\s*step\.param <= ConwayGraph::T_TRUNCATE_FAR_MAX;/,
    'is_morphable_step no longer uses the parsed truncate bounds',
  );
  assert.match(
    recipe,
    /case Op::CHAMFER:\s*return step\.param >= ConwayGraph::T_EPS && step\.param <= CHAMFER_T_MAX;/,
    'is_morphable_step no longer uses the parsed chamfer bounds',
  );

  assert.deepEqual(
    {
      truncate: MORPH_SWEEP.truncate.t,
      chamfer: MORPH_SWEEP.chamfer.t,
    },
    {
      truncate: { min: truncateMin, max: 1 - amboEpsilon },
      chamfer: { min: chamferMin, max: chamferMax },
    },
    'tools/solid_codegen.js MORPH_SWEEP drifted from engine HEAD',
  );
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
  assert.match(workflow, /\) \|\| true/);
  assert.match(workflow, /if \[ "\$run_status" = completed \]/);
  assert.match(workflow, /POV CI for \$PIN concluded \$run_conclusion/);
  assert.match(workflow, /published no verified engine bundle/);
});

test('pre-push verifies the working-tree artifacts', () => {
  assert.match(text('.githooks/pre-push'), /DAYDREAM_WASM_CLEAN_REQUIRED=1/);
});
