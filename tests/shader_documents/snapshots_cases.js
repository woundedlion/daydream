import { singlePatternCatalog, paramRow, ownedEditors, ENGINE_CATALOG, SCRATCH, MODULE, promotedDocument, onChange, withoutEmbeddedModulation, CHAIN_STUDY, editorWorkbench, displayedParameter, stageEditor, savedValues, affineLatticeStudy } from "../helpers/shader_document_harness.js";
import { compileShaderDocument } from "../../generated/shader/shader_workbench.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { applyChainDocument } from "../../src/workbench/shader/chain_apply.js";
import { callWorkbenchBinding } from "../../src/engine/workbench_bindings.js";
import { scratchChainDocument } from "../../src/workbench/shader/chain_document_store.js";
import { CHAIN_SNAPSHOT_SCHEMA_VERSION, decodeShaderStateHash, encodeShaderStateHash } from "../../src/workbench/shader/shader_deeplink.js";
import { FakeChainEngine, ParamSetResult, ChainSnapshotRestoreResult } from "../helpers/fake_engine.js";

test('a chain snapshot restores its program and accepted parameters into the editor', async () => {
  const engine = new FakeChainEngine();
  engine.setEffect('shader-chain');
  engine.setParameter('sample.pattern-freq', 2.25);
  engine.setAnimationsPaused(true);
  const bindings = engine.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  bindings.delete();
  const harness = await editorWorkbench({source: null, pausedFromEngine: true,
    search: `?effect=ShaderChain&fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}`});
  assert.equal(harness.elements.get('shader-animation-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(harness.animationWrites.at(-1), true);
  const restored = harness.engine.getShaderChainBindings();
  assert.deepEqual(restored.getProgram(), snapshot.chain);
  assert.equal(harness.engine.getParameterDefinitions().find((entry) => entry.name === 'sample.pattern-freq').acceptedValue, 2.25);
  restored.delete();
  const linked = await decodeShaderStateHash(harness.win.location.hash);
  assert.deepEqual(JSON.parse(JSON.stringify(linked.chainSnapshot)), snapshot);
  assert.equal(linked.paused, snapshot.animationsPaused);
  assert.equal(harness.controller.preservesOriginalLink(), false);
});

for (const route of ['link', 'query']) {
  test(`schema ${CHAIN_SNAPSHOT_SCHEMA_VERSION} ${route} Twist snapshots restore total angles and runtime`, async () => {
    const catalog = JSON.parse(ENGINE_CATALOG);
    const twist = catalog.operators.find((operator) => operator.id === 'sphere.lens.twist.v2');
    const document = scratchChainDocument(catalog, [
      {label: 'lens', operator: twist.id}, ...SCRATCH.descriptor.chain,
    ]);
    const distribution = Math.fround(0.7);
    const angle = -9;
    Object.assign(document.preset_bank.presets[0].values,
      {'lens.twist-angle': angle, 'lens.twist-distribution': distribution});
    const engine = new FakeChainEngine();
    engine.catalog = catalog;
    engine.setEffect('shader-chain');
    const compiled = compileShaderDocument(document, {catalog});
    assert.equal(compiled.status, 'VALID');
    assert.equal(applyChainDocument({engine, module: MODULE, compiled, presetId: 'catalog-defaults',
      syncEffectGui() {}, invalidate() {}}), null);
    const snapshot = callWorkbenchBinding(engine, 'getSnapshot', []);
    snapshot.schemaVersion = CHAIN_SNAPSHOT_SCHEMA_VERSION;
    Object.assign(snapshot.runtime.find(({instance}) => instance === 'lens').state,
      {primary: 0.375, secondary: -0.625, angle: 1.25});
    snapshot.animationsPaused = true;
    const before = structuredClone(snapshot);
    const payload = gzipSync(JSON.stringify({d: document, p: 'catalog-defaults', b: [], a: true, s: snapshot})).toString('base64url');
    const hash = route === 'link' ? `#shader=v2.${payload}` : '';
    const search = route === 'query' ? `?fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}`
      : '?effect=ShaderChain';
    const harness = await editorWorkbench({source: null, hash, search,
      engineCatalog: JSON.stringify(catalog), pausedFromEngine: true});
    assert.equal(harness.controller.preservesOriginalLink(), false,
      harness.elements.get('shader-document-status').textContent);
    const restored = callWorkbenchBinding(harness.engine, 'getSnapshot', []);
    assert.equal(restored.parameters.find(({name}) => name === 'lens.twist-angle')?.value, angle);
    assert.deepEqual(restored.runtime, snapshot.runtime);
    assert.deepEqual(restored.paletteBank, snapshot.paletteBank);
    assert.equal(restored.animationsPaused, true);
    assert.equal(savedValues(harness)['lens.twist-angle'], angle);
    assert.deepEqual(snapshot, before);
  });
}

test('a refused chain snapshot rolls the engine back and keeps the link', async () => {
  const engine = new FakeChainEngine();
  engine.setEffect('shader-chain');
  const snapshot = { ...engine.getShaderChainBindings().getSnapshot(), runtime: [] };
  const restores = [];
  const harness = await editorWorkbench({ source: null,
    search: `?effect=ShaderChain&fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}`,
    prepare: (target) => {
      target.setEffect('shader-chain');
      target.setParameter('sample.pattern-freq', 2.25);
      const bindings = target.getShaderChainBindings.bind(target);
      target.getShaderChainBindings = () => {
        const live = bindings();
        if (!live) return live;
        const restore = live.restoreSnapshot;
        live.restoreSnapshot = (value) => {
          const outcome = restore(value);
          restores.push({ value: structuredClone(value), outcome });
          return outcome;
        };
        return live;
      };
    } });
  assert.deepEqual(restores.map(({ outcome }) => outcome),
    [ChainSnapshotRestoreResult.INVALID_VALUE, ChainSnapshotRestoreResult.APPLIED]);
  assert.deepEqual(restores[0].value, snapshot);
  assert.equal(restores[1].value.parameters.find(({ name }) => name === 'sample.pattern-freq').value, 2.25,
    'the rollback restores the engine state from before the import');
  assert.equal(harness.controller.preservesOriginalLink(), true);
  assert.match(harness.elements.get('shader-document-status').textContent, /imported chain snapshot was rejected/);
});

test('a chain snapshot naming an unknown parameter is refused before adoption', async () => {
  const engine = new FakeChainEngine();
  engine.setEffect('shader-chain');
  const snapshot = engine.getShaderChainBindings().getSnapshot();
  snapshot.parameters = [...snapshot.parameters, { name: 'missing.parameter', value: 0 }];
  const harness = await editorWorkbench({ source: null,
    search: `?effect=ShaderChain&fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}` });
  assert.equal(harness.controller.preservesOriginalLink(), true);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /unknown chain snapshot parameter: missing\.parameter/);
});

test('a linked runtime snapshot that disagrees with its document retains the original link', async () => {
  const seed = await editorWorkbench({source: null});
  const state = await decodeShaderStateHash(seed.win.location.hash);
  state.chainSnapshot.parameters[0].value += 1;
  state.paused = true;
  state.chainSnapshot.animationsPaused = true;
  const hash = await encodeShaderStateHash(state);
  const harness = await editorWorkbench({source: null, hash});
  assert.equal(harness.controller.preservesOriginalLink(), true);
  assert.equal(harness.win.location.hash, hash);
  assert.match(harness.elements.get('shader-document-status').textContent, /does not match/);
  assert.equal(harness.animationsPaused(), false, 'a refused link preserves the fallback pause state');
  await harness.controller.dispose();
  ownedEditors.delete(harness.controller);
  assert.equal(harness.win.location.hash, hash);
});

test('a linked modulation recipe must match its document before restoration', async () => {
  const seed = await editorWorkbench();
  const original = await decodeShaderStateHash(seed.win.location.hash);
  assert.ok(original.chainSnapshot.modulation.length > 0);
  for (const change of [
    (recipe) => { recipe.mechanic.amount += 0.25; },
    (recipe) => { recipe.sine.offset += 0.25; },
    (recipe) => { recipe.noise = null; },
  ]) {
    const state = structuredClone(original);
    change(state.chainSnapshot.modulation[0].recipe);
    const hash = await encodeShaderStateHash(state);
    const harness = await editorWorkbench({source: null, hash});
    assert.equal(harness.controller.preservesOriginalLink(), true);
    assert.equal(harness.win.location.hash, hash);
    assert.match(harness.elements.get('shader-document-status').textContent, /does not match/);
  }
  const rounded = structuredClone(original);
  const recipe = rounded.chainSnapshot.modulation[0].recipe;
  recipe.noise.scale += 1e-8;
  rounded.chainSnapshot.modulation[0].recipe = Object.fromEntries(Object.entries(recipe).reverse());
  const harness = await editorWorkbench({source: null, hash: await encodeShaderStateHash(rounded)});
  assert.equal(harness.controller.preservesOriginalLink(), false);
  assert.doesNotMatch(harness.elements.get('shader-document-status').textContent, /does not match/);
});

test('abandoning a refused link reports its release once', async () => {
  let releases = 0;
  const harness = await editorWorkbench({ source: null,
    search: '?effect=ShaderChain&fx.__chainSnapshot=%7Bbroken',
    onOriginalLinkReleased: () => { releases++; },
  });
  assert.equal(harness.controller.preservesOriginalLink(), true);
  assert.equal(releases, 0);
  const picker = harness.elements.get('shader-document-file');
  picker.files = [{ name: 'study.shader.json', size: CHAIN_STUDY.length,
    text: async () => CHAIN_STUDY }];
  await onChange(picker)();
  assert.equal(harness.controller.preservesOriginalLink(), false);
  assert.equal(releases, 1);
  assert.equal(await harness.controller.loadSource(CHAIN_STUDY), true);
  assert.equal(releases, 1);
});

test('the descriptor digest button copies the full digest and announces failures', async () => {
  const harness = await editorWorkbench();
  const button = harness.elements.get('shader-document-digest');
  const status = harness.elements.get('shader-document-status');
  assert.equal(button.disabled, false);
  const digest = button.dataset.digest;
  assert.ok(digest.length > button.textContent.length);
  const copied = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const clipboard = { writeText: async (text) => { copied.push(text); } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  const onClick = button.listeners.find((entry) => entry.type === 'click').handler;
  try {
    await onClick();
    assert.deepEqual(copied, [digest]);
    assert.equal(status.textContent, `Copied the descriptor digest ${digest}.`);
    clipboard.writeText = async () => { throw new Error('clipboard refused'); };
    document.execCommand = () => false;
    await onClick();
    assert.equal(status.textContent, 'The descriptor digest could not be copied.');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test('compiled lattice edits keep the authored fallback period and reapply', async () => {
  const source = withoutEmbeddedModulation(JSON.stringify(promotedDocument('grid_space.shader.json')));
  const harness = await editorWorkbench({ source, sourceFiles: {'grid_space.shader.json': source}, patternCatalog: singlePatternCatalog('grid-space', 'grid_space.shader.json', 'Grid Space') });
  const original = savedValues(harness);
  const toggle = harness.elements.get('shader-parity-toggle');
  assert.equal(toggle.disabled, false);
  toggle.dispatch('click');
  const edit = stageEditor(harness, 'sample');
  edit('sample.cell-scale', 2.7);
  edit('sample.cell-scale', 3.1);
  const values = savedValues(harness);
  assert.equal(Math.fround(values['sample.cell-scale']), Math.fround(3.1));
  assert.equal(values['warp1.lattice-period'], original['warp1.lattice-period']);
  const period = displayedParameter(harness, 'warp1', 'warp1.lattice-period');
  assert.equal(Math.fround(Number(period)), values['warp1.lattice-period']);
  await onChange(harness.elements.get('shader-preset-select'))();
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'ok');
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(savedValues(harness), original);
  harness.elements.get('chain-strip').querySelector('.chain-redo').dispatch('click');
  assert.deepEqual(savedValues(harness), values);
  toggle.dispatch('click');
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'ok');
});

test('an affine fallback period stays editable beside a lattice source', async () => {
  const harness = await editorWorkbench(affineLatticeStudy());
  assert.equal(savedValues(harness)['warp.lattice-period'], 1);
  const batches = [];
  const apply = harness.engine.bindings.setShaderChainParameters;
  harness.engine.bindings.setShaderChainParameters = (writes) => {
    batches.push(writes);
    return apply(writes);
  };
  stageEditor(harness, 'sample')('sample.cell-scale', 2.7);
  assert.ok(batches.flat().every(({ name }) => name !== 'warp.lattice-period'));
  assert.equal(savedValues(harness)['warp.lattice-period'], 1);
  stageEditor(harness, 'warp')('warp.lattice-period', 0.75);
  assert.equal(savedValues(harness)['warp.lattice-period'], 0.75);
  const row = paramRow(harness, 'warp', 'warp.lattice-period');
  assert.equal(row.querySelector('.chain-param-control').disabled, false);
});

test('authored compiled stage edits keep camera spin, coverage and independent affine period live', async () => {
  const source = JSON.stringify(scratchChainDocument(JSON.parse(ENGINE_CATALOG),
    promotedDocument('grid_space.shader.json').descriptor.chain.filter((entry) => entry.operator !== 'color.modulate.v1')));
  const harness = await editorWorkbench({source, sourceFiles: {'grid_space.shader.json': source},
    patternCatalog: singlePatternCatalog('grid-space', 'grid_space.shader.json', 'Grid Space')});
  const definitions = harness.compiledEngine.getParameterDefinitions();
  definitions.push({name: 'camera.Wander'}, {name: 'camera.Spin Speed'},
    {name: 'outer_warp.Lattice Period'},
    {name: 'coverage-mode', options: ['None', 'Weight', 'Weight Squared', 'Edge Fade']});
  harness.elements.get('shader-parity-toggle').dispatch('click');
  harness.compiledEngine.writes.length = 0;
  stageEditor(harness, 'camera')('camera.wander', 0.4);
  stageEditor(harness, 'camera')('camera.spin-speed', 0.03);
  stageEditor(harness, 'warp1')('warp1.lattice-period', 0.413);
  stageEditor(harness, 'sample')('sample.cell-scale', 3.1);
  stageEditor(harness, 'sample')('sample.coverage-mode', 'edge-fade');
  assert.deepEqual(harness.compiledEngine.writes, [
    ['camera.Wander', 0.4], ['camera.Spin Speed', 0.03],
    ['outer_warp.Lattice Period', 0.413], ['Cell Scale', 3.1], ['coverage-mode', 3],
  ]);
  const saved = savedValues(harness);
  assert.equal(saved['warp1.lattice-period'], Math.fround(0.413));
  assert.equal(saved['camera.spin-speed'], Math.fround(0.03));
  assert.equal(saved['sample.coverage-mode'], 'edge-fade');
});

test('authored compiled modulation edits replay coupled source and amount writes after admission dependencies', async () => {
  const source = JSON.stringify(promotedDocument('grid_space.shader.json'));
  const harness = await editorWorkbench({source, sourceFiles: {'grid_space.shader.json': source},
    patternCatalog: singlePatternCatalog('grid-space', 'grid_space.shader.json', 'Grid Space')});
  const definitions = harness.compiledEngine.getParameterDefinitions();
  const modulation = JSON.parse(ENGINE_CATALOG).operators.find((entry) => entry.id === 'color.modulate.v1');
  for (const field of modulation.params.filter((field) => field.topology))
    definitions.push({name: field.id, options: field.values});
  harness.elements.get('shader-parity-toggle').dispatch('click');
  assert.equal(harness.elements.get('shader-parity-toggle').getAttribute('aria-pressed'), 'true');
  const native = {'modulation-source': 0, 'modulation-evaluation': 1,
    'modulation-mechanic': 0, 'Modulation Amount': 2};
  const attempts = [];
  harness.compiledEngine.setParameter = (name, value) => {
    attempts.push([name, value]);
    if (name === 'modulation-source' && value !== 0 && native['modulation-evaluation'] !== 0)
      return ParamSetResult.INADMISSIBLE;
    if (name === 'modulation-mechanic' && value !== 0 && native['Modulation Amount'] > 1)
      return ParamSetResult.INADMISSIBLE;
    native[name] = value;
    return ParamSetResult.APPLIED;
  };
  const edit = stageEditor(harness, 'modulation');
  edit('modulation.modulation-source', 'sphere-interference');
  assert.deepEqual(attempts, [
    ['modulation-source', 2], ['modulation-evaluation', 0], ['modulation-source', 2],
  ]);
  attempts.length = 0;
  edit('modulation.modulation-amount', 2);
  attempts.length = 0;
  edit('modulation.modulation-mechanic', 'positive-lightness-lift');
  assert.deepEqual(attempts, [
    ['modulation-mechanic', 1], ['Modulation Amount', 1], ['modulation-mechanic', 1],
  ]);
  const saved = savedValues(harness);
  assert.equal(saved['modulation.modulation-source'], 'sphere-interference');
  assert.equal(saved['modulation.modulation-evaluation'], 'direct');
  assert.equal(saved['modulation.modulation-mechanic'], 'positive-lightness-lift');
  assert.equal(saved['modulation.modulation-amount'], 1);
  assert.equal(native['modulation-source'], 2);
  assert.equal(native['modulation-mechanic'], 1);
});

for (const failure of ['editor', 'runtime']) {
  test(`a ${failure} adoption failure restores the document, strip and program`, async () => {
    let refuseEditor = false;
    const compiler = await import("../../generated/shader/shader_workbench.mjs");
    const harness = await editorWorkbench({ importCompiler: async () => ({ ...compiler,
      validateShaderDocument(...args) {
        if (refuseEditor) throw new Error('editor adoption refused');
        return compiler.validateShaderDocument(...args);
      },
    }) });
    const previous = savedValues(harness);
    const strip = harness.elements.get('chain-strip').children[0];
    const snapshot = callWorkbenchBinding(harness.engine, 'getSnapshot', []);
    const document = JSON.parse(CHAIN_STUDY);
    let session;
    if (failure === 'editor') refuseEditor = true;
    else {
      session = { preset: document.preset_bank.presets[0].preset_id, bypassed: [],
        paused: false, chainSnapshot: snapshot };
      const original = harness.engine.getShaderChainBindings.bind(harness.engine);
      let calls = 0;
      harness.engine.getShaderChainBindings = () => {
        const bindings = original();
        const restore = bindings.restoreSnapshot;
        bindings.restoreSnapshot = (value) => ++calls === 1
          ? ChainSnapshotRestoreResult.INVALID_VALUE : restore(value);
        return bindings;
      };
    }
    assert.equal(await harness.controller.loadSource(document, 'refused.shader.json', null, session), false);
    assert.match(harness.elements.get('shader-document-status').textContent,
      failure === 'editor' ? /editor adoption refused/ : /runtime snapshot was rejected/);
    assert.equal(harness.elements.get('chain-strip').children[0], strip);
    assert.deepEqual(savedValues(harness), previous);
    assert.deepEqual(callWorkbenchBinding(harness.engine, 'getSnapshot', []), snapshot);
  });
}

for (const operator of ['sphere.lens.mobius.v2', 'sphere.displace.symmetric.v1',
  'colorize.generated-palette.v3', 'modulate.field.v1', 'modulate.hue-shift.v1']) {
  test(`opening retired operator ${operator} preserves the current document`, async () => {
    const harness = await editorWorkbench();
    const before = callWorkbenchBinding(harness.engine, 'getSnapshot', [], null);
    const retired = JSON.parse(CHAIN_STUDY);
    retired.descriptor.chain[0].operator = operator;
    assert.equal(await harness.controller.loadSource(retired), false);
    assert.equal(harness.elements.get('shader-document-status').dataset.status, 'error');
    assert.match(harness.elements.get('shader-document-status').textContent,
      new RegExp(`UNKNOWN_OPERATOR .*"${operator.replaceAll('.', '\\.')}"`));
    assert.deepEqual(callWorkbenchBinding(harness.engine, 'getSnapshot', [], null), before);
    assert.equal(await harness.controller.loadSource(CHAIN_STUDY), true);
  });
}

for (const schemaVersion of [1, 3, 4, 10, 11]) {
  test(`stored snapshot version ${schemaVersion} is refused before engine restore`, async () => {
    const loaded = await editorWorkbench();
    const snapshot = callWorkbenchBinding(loaded.engine, 'getSnapshot', [], null);
    const current = structuredClone(snapshot);
    snapshot.schemaVersion = schemaVersion;
    const search = `?fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}`;
    let restores = 0;
    const refused = await editorWorkbench({source: null, search, prepare(target) {
      const bindings = target.getShaderChainBindings.bind(target);
      target.getShaderChainBindings = () => {
        const live = bindings();
        if (!live) return live;
        const restore = live.restoreSnapshot;
        live.restoreSnapshot = value => { restores++; return restore(value); };
        return live;
      };
    }});
    assert.match(refused.elements.get('shader-document-status').textContent, /unsupported chain snapshot/);
    assert.equal(restores, 0);
    assert.equal(refused.controller.preservesOriginalLink(), true);
    assert.equal(refused.win.location.search, search);
    const accepted = await editorWorkbench({source: null,
      search: `?fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(current))}`});
    assert.match(accepted.elements.get('shader-document-status').textContent, /Restored the chain snapshot/);
  });
}

test('an untouched linked scratch chain keeps its source and saved baseline', async () => {
  const hash = await encodeShaderStateHash({ document: SCRATCH,
    preset: SCRATCH.preset_bank.presets[0].preset_id, bypassed: [], paused: false });
  const h = await editorWorkbench({ source: null, hash });
  const source = h.elements.get('shader-document-select');
  assert.equal(source.value, '');
  h.win.confirm = () => { throw new Error('unexpected discard prompt'); };
  source.value = '';
  await onChange(source)();
  h.controller.save();
  assert.equal(h.downloads.at(-1)[0], 'scratch.shader.json');
});

test('hash navigation loads a new shader and disposal removes its listener', async () => {
  const h = await editorWorkbench({ source: null });
  assert.equal(h.win.listenerCount('hashchange'), 1);
  const document = structuredClone(SCRATCH);
  document.preset_bank.presets[0].values['sample.pattern-freq'] = 3.5;
  h.win.location.hash = await encodeShaderStateHash({ document,
    preset: document.preset_bank.presets[0].preset_id, bypassed: [], paused: false });
  await h.win.listeners.find(listener => listener.type === 'hashchange').handler();
  h.controller.save();
  assert.equal(JSON.parse(h.downloads.at(-1)[1]).preset_bank.presets[0]
    .values['sample.pattern-freq'], 3.5);
  await h.controller.dispose();
  ownedEditors.delete(h.controller);
  assert.equal(h.win.listenerCount('hashchange'), 0);
});

test('declined hash navigation restores the kept edits in the session link', async () => {
  const h = await editorWorkbench();
  stageEditor(h, 'sample')('sample.pattern-freq', 3.5);
  await h.controller.flushDeepLink();
  const keptHash = h.win.location.hash;
  let confirmations = 0;
  h.win.confirm = () => { confirmations += 1; return false; };
  const document = structuredClone(SCRATCH);
  h.win.location.hash = await encodeShaderStateHash({document,
    preset: document.preset_bank.presets[0].preset_id, bypassed: [], paused: false});
  assert.notEqual(h.win.location.hash, keptHash);
  await h.win.listeners.find(listener => listener.type === 'hashchange').handler();
  await h.controller.flushDeepLink();
  assert.equal(confirmations, 1);
  assert.equal(h.win.location.hash, keptHash);
});
