import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  BAKED_CONSTANT_IDS, bakedTopologyFields, engineParameterNames,
} from '../tools/shader_documents.js';
import { MORPH_SWEEP, OP_DEFS } from '../tools/solid_codegen.js';

const text = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const engineCandidates = process.env.HOLOSPHERE_ENGINE_DIR
  ? [resolve(process.env.HOLOSPHERE_ENGINE_DIR)]
  : ['engine', '../Holosphere', '../pov'].map((path) => resolve(path));
const engineRoot = engineCandidates.find(
  (path) => existsSync(resolve(path, 'scripts/shader_workbench.mjs')));
const engineMissing = `no Holosphere checkout found in ${engineCandidates.join(', ')}`;
const engineSkip = engineRoot || process.env.HOLOSPHERE_ENGINE_REQUIRED ? false : engineMissing;

const enginePin = text('holosphere_wasm.sha').trim();
const committed = (root, path, revision = enginePin) => execFileSync(
  'git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'buffer' });

function cppFloatConstant(source, name) {
  const match = new RegExp(
    `\\binline\\s+constexpr\\s+float\\s+${name}\\s*=\\s*` +
      '([0-9]+(?:\\.[0-9]*)?(?:[eE][+-]?[0-9]+)?f?)\\s*;',
  ).exec(source);
  assert.ok(match, `engine source does not declare literal float ${name}`);
  return Number(match[1].replace(/f$/, ''));
}

test('the installed WASM artifacts match their recorded hashes', () => {
  const entries = text('holosphere_wasm.wasm.sha256')
    .trim().split(/\r?\n/)
    .map((line) => line.match(/^([0-9a-f]{64})\s+\*?(.+)$/));
  for (const entry of entries) assert.ok(entry, 'each checksum line has sha256sum syntax');
  assert.deepEqual(entries.map((entry) => entry[2]).sort(),
    ['holosphere_wasm.js', 'holosphere_wasm.wasm'],
    'the manifest names the glue and the binary and nothing else');
  for (const entry of entries) assert.equal(sha256(entry[2]), entry[1], entry[2]);
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

test('the installed operator catalog describes the installed WASM', async () => {
  const { default: createModule } = await import('../holosphere_wasm.js');
  const module = await createModule();
  assert.deepEqual(JSON.parse(text('shader/engine_catalog.json')),
    JSON.parse(module.HolosphereEngine.getShaderChainCatalog()));
});

// One id per alias branch, so the comparison keeps covering the table when the
// committed documents stop exercising a branch.
const ALIAS_PROBES = [
  'bare-id', 'warp1.rotation-rate', 'warp2.radial-scale', 'warp1.cell-x',
  'warp2.field-angle', 'warp1.unaliased-field', 'surface.scale', 'camera.wander',
  'sample.angle-speed', 'lens.symmetry',
];

const controlNameCorpus = () => {
  const ids = new Set(ALIAS_PROBES);
  for (const name of readdirSync('shader/patterns')) {
    if (!name.endsWith('.shader.json')) continue;
    for (const parameter of JSON.parse(text(`shader/patterns/${name}`))
      .descriptor?.parameters ?? []) ids.add(parameter.id);
  }
  return [...ids].sort();
};

// tools/shader_documents.js re-implements the engine's promoted-binding
// predicates for the browser: the live topology field, the baked topology set,
// the baked-constant exemption and the control-name alias table. That module is
// not installed here, so the two are pinned by behaviour rather than by bytes.
test('the browser promoted-binding predicates agree with the installed engine pin',
  { skip: engineSkip }, async (t) => {
    assert.ok(engineRoot, engineMissing);
    const revision = enginePin;
    const snapshot = mkdtempSync(resolve(tmpdir(), 'daydream-engine-predicates-'));
    t.after(() => rmSync(snapshot, { recursive: true, force: true }));
    for (const name of ['wasm_smoke_predicates.mjs', 'shader_workbench.mjs', 'sha256.mjs'])
      writeFileSync(resolve(snapshot, name), committed(engineRoot, `scripts/${name}`, revision));
    const predicates = await import(pathToFileURL(resolve(snapshot, 'wasm_smoke_predicates.mjs')).href);
    const catalog = JSON.parse(text('shader/engine_catalog.json'));
    assert.deepEqual(
      [...bakedTopologyFields(catalog)].sort(),
      [...predicates.bakedTopologyFields(catalog)].sort(),
      'the baked topology fields drifted from the installed engine pin',
    );
    assert.deepEqual(
      [...BAKED_CONSTANT_IDS].sort(),
      [...predicates.BAKED_CONSTANT_IDS].sort(),
      'the baked-constant exemption drifted from the installed engine pin',
    );
    for (const parameterId of controlNameCorpus()) {
      assert.deepEqual(
        engineParameterNames(parameterId),
        predicates.engineControlNames(parameterId),
        `the control names for "${parameterId}" drifted from the installed engine pin`,
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
  const truncate = recipe.match(
    /case Op::TRUNCATE:\s*return step\.param >= ConwayGraph::T_TRUNCATE_ARRIVAL_MIN &&\s*step\.param <= ConwayGraph::T_TRUNCATE_FAR_MAX &&\s*step\.param != ([0-9.]+)f;/,
  );
  assert.ok(truncate,
    'is_morphable_step no longer uses the parsed truncate bounds and exclusion');
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
      truncate: { min: truncateMin, max: 1 - amboEpsilon, excluded: [Number(truncate[1])] },
      chamfer: { min: chamferMin, max: chamferMax },
    },
    'tools/solid_codegen.js MORPH_SWEEP drifted from the installed engine pin',
  );
});

test('deploy consumes one checksummed engine bundle at the module pin', () => {
  const workflow = text('.github/workflows/engine-bundle.yml');
  assert.match(workflow, /holosphere-engine-\$PIN/);
  assert.match(workflow, /head_sha=\$PIN&branch=master&per_page=10/);
  assert.match(workflow,
    /select\(\.event == "push" or \.event == "workflow_dispatch"\)/);
  assert.match(workflow, /sha256sum -c holosphere_engine\.sha256/);
  assert.match(workflow, /node scripts\/install-engine-bundle\.mjs engine-bundle/);
  assert.doesNotMatch(workflow, /cmp -s/);
  assert.doesNotMatch(workflow, /cmake --build|path: engine\s*$/m);
});

// A served Content-Type needs a live URL, so only the assets behind it can be
// checked ahead of the deployment; the presence check is that half.
test('deploy checks the engine assets it stages before it publishes them', () => {
  const workflow = text('.github/workflows/deploy.yml');
  const staged = workflow.indexOf('name: Verify the staged engine assets');
  const published = workflow.indexOf('uses: actions/deploy-pages@');
  const served = workflow.indexOf('name: Verify published engine MIME types');
  assert.ok(staged >= 0 && published >= 0 && served >= 0,
    `staged ${staged}, published ${published}, served ${served}`);
  assert.ok(staged < published, 'the staged assets are checked before publication');
  assert.ok(published < served, 'a served Content-Type exists only once published');
});

test('deploy stops waiting when the pinned engine run cannot publish', () => {
  const workflow = text('.github/workflows/engine-bundle.yml');
  assert.doesNotMatch(workflow, /\|\| true/);
  assert.match(workflow, /if \[ "\$run_status" = completed \]/);
  assert.match(workflow, /POV CI for \$PIN concluded \$run_conclusion/);
  assert.match(workflow, /published no verified engine bundle/);
});

test('the engine checkout can fetch a pin after master advances', () => {
  const workflow = text('.github/workflows/js-unit-suite.yml');
  const checkout = workflow.match(
    /- name: Checkout the pinned engine\n[\s\S]*?(?=\n\s{6}- )/,
  )?.[0] ?? '';
  assert.match(checkout, /fetch-depth: 0/);
});

// The engine-parity cases above and the hook cases skip without their flag, so
// the workflow's declaration of the flags is what keeps a run that lost its
// engine checkout or its shell from passing on nothing.
test('the JS unit suite arms the engine-parity and hook cases', () => {
  const workflow = text('.github/workflows/js-unit-suite.yml');
  const checkout = workflow.match(
    /- name: Checkout the pinned engine\n[\s\S]*?(?=\n\s{6}- )/,
  )?.[0] ?? '';
  assert.match(checkout, /^\s+path: engine$/m);
  const step = workflow.match(/- name: Test\n[\s\S]*?(?=\n\s{6}- |\s*$)/)?.[0] ?? '';
  assert.match(step, /^\s+HOLOSPHERE_ENGINE_REQUIRED: '1'$/m);
  assert.match(step, /^\s+DAYDREAM_HOOK_SH_REQUIRED: '1'$/m);
  assert.match(step, /^\s+run: npm test$/m);
});

test('CI checks source parity after installing the selected runtime', () => {
  const suite = text('.github/workflows/js-unit-suite.yml');
  assert.ok(suite.indexOf('name: Install the verified engine package') < suite.indexOf('name: Resolve engine pin'));
  assert.ok(suite.indexOf('name: Resolve engine pin') < suite.indexOf('name: Checkout the pinned engine'));
  assert.match(suite, /HOLOSPHERE_ENGINE_REQUIRED: '1'/);
});

for (const name of ['shader_workbench.mjs', 'sha256.mjs']) {
  test(`shader mirror ${name} matches the pinned engine`, { skip: engineSkip }, () => {
    assert.ok(engineRoot, engineMissing);
    const pin = text('holosphere_wasm.sha').trim();
    assert.equal(text(`shader/${name}`),
      committed(engineRoot, `scripts/${name}`, pin).toString('utf8').replaceAll('\r\n', '\n'));
  });
}

test('pattern mirrors match the pinned engine in both content and membership', { skip: engineSkip }, () => {
  assert.ok(engineRoot, engineMissing);
  const mirrored = (name) => name.endsWith('.shader.json') || name === 'shaderball_migration.json';
  const expected = execFileSync('git', ['-C', engineRoot, 'ls-tree', '--name-only',
    `${enginePin}:patterns`], { encoding: 'utf8' }).trim().split('\n').filter(mirrored).sort();
  const actual = readdirSync('shader/patterns').filter(mirrored).sort();
  assert.deepEqual(actual, expected);
  for (const name of expected) {
    assert.equal(text(`shader/patterns/${name}`),
      committed(engineRoot, `patterns/${name}`).toString('utf8').replaceAll('\r\n', '\n'), name);
  }
});

test('composite sweep exemptions stay inside the engine primitive bands', { skip: engineSkip }, () => {
  assert.ok(engineRoot, engineMissing);
  const recipe = committed(engineRoot, 'core/mesh/recipe.h').toString('utf8');
  const expansion = recipe.slice(recipe.indexOf('size_t expand_to_primitives'));
  for (const [name, expected] of Object.entries({
    GYRO: ['SNUB', 'DUAL'], META: ['AMBO', 'DUAL', 'KIS'],
    NEEDLE: ['DUAL', 'KIS'], ZIP: ['KIS', 'DUAL'], BEVEL: ['AMBO', 'AMBO', 'TRUNCATE'],
  })) {
    const body = expansion.match(new RegExp(`case Op::${name}:([\\s\\S]*?)break;`))?.[1];
    assert.ok(body, name);
    assert.deepEqual([...body.matchAll(/emit\(\{Op::(\w+)/g)].map((match) => match[1]), expected);
  }
  const graph = committed(engineRoot, 'core/mesh/conway_graph.h').toString('utf8');
  assert.ok(OP_DEFS.bevel.params.t.min >= cppFloatConstant(graph, 'T_TRUNCATE_ARRIVAL_MIN'));
  assert.ok(OP_DEFS.bevel.params.t.max <= 1 - cppFloatConstant(graph, 'T_EPS_AMBO'));
  assert.match(expansion, /if \(step\.param == 0\.5f\)\s*emit\(\{Op::AMBO\}\);/);
  const conway = committed(engineRoot, 'core/mesh/conway.h').toString('utf8');
  assert.ok(cppFloatConstant(conway, 'SNUB_DEFAULT_T') > 0);
});
