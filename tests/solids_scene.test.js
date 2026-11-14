import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {fakeElement} from './helpers/fake_dom.js';
import {createSolidsPage} from '../src/workbench/solids/solids_state.js';
import {createSolidsScene} from '../src/workbench/solids/solids_scene.js';
import {createSolidsEngine} from '../src/workbench/solids/solids_engine.js';
import {createSolidsBasePicker} from '../src/workbench/solids/solids_base_picker.js';
import {createSolidsOpGateView} from '../src/workbench/solids/solids_op_gate_view.js';
import {createSolidsOpsController} from '../src/workbench/solids/solids_ops_controller.js';
import {createSolidsSavedController} from '../src/workbench/solids/solids_saved_controller.js';

test('mounting the solids scene wires its callbacks and disposes every owned resource', () => {
  const page = createSolidsPage(undefined);
  const canvas = fakeElement('canvas');
  const labels = fakeElement('div');
  const disposals = [];
  const teardown = [];
  const mounted = {scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    renderer: {}, controls: {autoRotate: true}, dispose: () => disposals.push('scene')};
  let options;
  let materials;
  let reducedMotionChanged;
  const actions = {
    scheduleUpdate: {cancel: () => disposals.push('frame')},
    wireViewToggles: () => disposals.push('toggles-wired'),
    wireCanvasTap: element => assert.equal(element, canvas),
    updateLabels() {},
    setAutoRotate(on) { page.view.autoRotate = on; },
  };
  const scene = createSolidsScene(page, actions, {
    document: {getElementById: id => id === 'canvas' ? canvas : labels},
    initScene(container, id, settings) {
      assert.equal(container, 'canvas-container');
      assert.equal(id, 'canvas');
      options = settings;
      return mounted;
    },
    watchMediaMatch(media, changed) {
      assert.equal(media, page.view.reducedMotion);
      reducedMotionChanged = changed;
      return () => disposals.push('media');
    },
    onPageTeardown: callback => teardown.push(callback),
    createMeshRenderer(context) {
      assert.equal(context.scene, mounted.scene);
      assert.equal(context.labelsContainer, labels);
      materials = context.materials;
      for (const [name, material] of Object.entries(materials))
        material.addEventListener('dispose', () => disposals.push(name));
      return {disposeGeometry: () => disposals.push('geometry')};
    },
  });
  scene.mountSolidScene();
  assert.equal(page.scene.camera, mounted.camera);
  assert.equal(page.scene.renderer, mounted.renderer);
  assert.equal(page.scene.controls, mounted.controls);
  assert.equal(options.onAfterRender, actions.updateLabels);
  assert.equal(options.autoRotate, true);
  assert.deepEqual(options.cameraPosition, [2, 1.5, 2]);
  assert.equal(materials.face.polygonOffset, true);
  assert.equal(materials.faceColorize.vertexColors, true);
  options.onAfterResize();
  assert.equal(page.scene.labelsNeedReproject, true);
  reducedMotionChanged();
  assert.equal(page.view.autoRotate, false);
  assert.deepEqual(disposals, ['toggles-wired']);
  teardown[0]();
  assert.deepEqual(disposals, ['toggles-wired', 'media', 'frame', 'geometry',
    'face', 'faceColorize', 'vert', 'edge', 'normal', 'scene']);
});

test('vertex labels cull hidden vertices and reproject only for changed camera or viewport', () => {
  const page = createSolidsPage(undefined);
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 2.5);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  page.scene.camera = camera;
  const labels = fakeElement('div');
  const front = fakeElement('span');
  const back = fakeElement('span');
  const distant = fakeElement('span');
  const missing = fakeElement('span');
  [front, back, distant, missing].forEach((label, index) => {
    label.dataset.index = index;
    labels.appendChild(label);
  });
  page.scene.labelsContainer = labels;
  page.mesh.currentMesh = {vertices: [new THREE.Vector3(0.2, 0.1, 1),
    new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0.1)], faces: []};
  page.view.showIndices = true;
  let projections = 0;
  page.scene.renderer = {getSize(size) { projections++; return size.set(400, 200); }};
  const actions = {};
  Object.assign(actions, createSolidsScene(page, actions));
  actions.updateLabels();
  assert.equal(projections, 1);
  assert.equal(front.style.display, 'block');
  assert.ok(parseFloat(front.style.left) > 200);
  assert.ok(parseFloat(front.style.top) < 100);
  assert.equal(back.style.display, 'none');
  assert.equal(distant.style.display, 'none');
  assert.equal(missing.style.display, '');
  actions.updateLabels();
  assert.equal(projections, 1);
  page.scene.labelsNeedReproject = true;
  actions.updateLabels();
  assert.equal(projections, 2);
  assert.equal(page.scene.labelsNeedReproject, false);
  camera.position.x = 0.1;
  camera.updateMatrixWorld();
  actions.updateLabels();
  assert.equal(projections, 3);
  camera.quaternion.x += 0.01;
  actions.updateLabels();
  assert.equal(projections, 4);
  page.view.showIndices = false;
  actions.updateLabels();
  assert.equal(projections, 4);
});

test('thumbnail generation publishes base and star previews and releases aborted or refused builds', async () => {
  for (const mode of ['complete', 'aborted', 'halted', 'refused']) {
    const page = createSolidsPage(undefined);
    page.registry.simpleSolids = ['cube'];
    page.registry.islamicStarPatterns = ['star'];
    page.engine.meshOpsWasm = mode === 'halted' ? null : {};
    const nodes = new Map(['baseSolids', 'starPatterns', 'baseThumb', 'baseTitle']
      .map(id => [id, fakeElement('div')]));
    const builds = [];
    const renderings = [];
    const disposals = [];
    const sizes = [];
    class ThumbnailRenderer {
      domElement = {toDataURL: () => `data:thumbnail-${builds.at(-1)}`};
      setSize(...size) { sizes.push(size); }
      setClearColor(color, alpha) { assert.equal(color, 0); assert.equal(alpha, 0); }
      render(scene, camera) {
        assert.equal(scene.children.length, 2);
        assert.equal(camera.aspect, 1);
        renderings.push('scene');
      }
      dispose() { disposals.push('renderer'); }
      forceContextLoss() { disposals.push('context'); }
    }
    const actions = {buildContext: () => ({}), showThumbnailError() {}};
    let materials;
    Object.assign(actions, createSolidsBasePicker(page, actions, {
      document: {getElementById: id => nodes.get(id), createElement: fakeElement,
        querySelectorAll: () => nodes.get('baseSolids').children},
      THREE: {...THREE, WebGLRenderer: ThumbnailRenderer},
      setTimeout: callback => callback(),
      buildBaseMesh(key) {
        builds.push(key);
        return mode === 'refused' ? null : {vertices: [], faces: []};
      },
      createMeshRenderer(context) {
        materials = context.materials;
        materials.face.addEventListener('dispose', () => disposals.push('face'));
        materials.edge.addEventListener('dispose', () => disposals.push('edge'));
        return {render(mesh, view, classes) {
          assert.equal(view.showFaces, true);
          assert.equal(view.showIndices, false);
          assert.equal(classes, null);
          renderings.push('mesh');
        }, disposeGeometry: () => disposals.push('geometry')};
      },
    }));
    const abort = new AbortController();
    if (mode === 'aborted') abort.abort();
    await actions.generateThumbnails(abort.signal);
    assert.deepEqual(sizes, [[256, 256]]);
    assert.equal(materials.face, materials.faceColorize);
    assert.deepEqual(disposals, ['geometry', 'face', 'edge', 'renderer', 'context']);
    const completed = mode === 'complete';
    assert.deepEqual(builds, ['complete', 'refused'].includes(mode) ? ['cube', 'star'] : []);
    assert.deepEqual(renderings, completed ? ['mesh', 'scene', 'mesh', 'scene'] : []);
    assert.equal(nodes.get('baseSolids').children.length, completed ? 1 : 0);
    assert.equal(nodes.get('starPatterns').children.length, completed ? 1 : 0);
    if (completed) {
      assert.equal(nodes.get('baseThumb').src, page.registry.baseThumbnails.cube);
      assert.equal(nodes.get('baseSolids').children[0].getAttribute('aria-checked'), 'true');
      assert.equal(nodes.get('starPatterns').children[0].getAttribute('role'), null);
      actions.renderBaseSolid();
      assert.equal(nodes.get('baseTitle').title, 'Cube');
      page.doc.base = 'unloaded';
      nodes.get('baseThumb').setAttribute('src', 'stale');
      actions.renderBaseSolid();
      assert.equal(nodes.get('baseThumb').getAttribute('src'), null);
    }
  }
});

test('engine stand-down drops live handles and freezes editing while retaining error reporting', () => {
  const page = createSolidsPage(undefined);
  const controls = [fakeElement('button'), fakeElement('input')];
  const stats = fakeElement('p');
  const thumbnails = fakeElement('p');
  const failures = [];
  const actions = {scheduleUpdate: {cancel: () => failures.push('cancel')}};
  Object.assign(actions, createSolidsEngine(page, actions, {
    document: {querySelectorAll: () => controls,
      getElementById: id => id === 'meshStats' ? stats : thumbnails},
    showFatalError: message => failures.push(message),
    console: {error() {}, warn() {}},
  }));
  page.engine.wasmModule = {};
  page.engine.meshOpsWasm = {};
  const context = actions.buildContext();
  assert.equal(context.Mod, page.engine.wasmModule);
  assert.equal(context.meshOps, page.engine.meshOpsWasm);
  assert.deepEqual(context.vector(1, 2, 3).toArray(), [1, 2, 3]);
  context.onError('mesh failed');
  actions.showThumbnailError('thumbnail failed');
  assert.equal(stats.textContent, 'mesh failed');
  assert.equal(thumbnails.textContent, 'thumbnail failed');
  assert.equal(actions.engineTrapped(new Error('recoverable')), false);
  context.onFatal('engine halted');
  assert.equal(page.engine.wasmModule, null);
  assert.equal(page.engine.meshOpsWasm, null);
  assert.deepEqual(controls.map(control => control.disabled), [true, true]);
  assert.deepEqual(failures, ['cancel', 'engine halted']);
});

test('default timers and cloning retain the browser global receiver', async () => {
  const nativeTimer = globalThis.setTimeout;
  const nativeClearTimer = globalThis.clearTimeout;
  const nativeClone = globalThis.structuredClone;
  const scheduled = [];
  const cancelled = [];
  let clones = 0;
  try {
    globalThis.setTimeout = function(callback, delay) {
      assert.equal(this, globalThis, 'native timers require their global receiver');
      scheduled.push(delay);
      if (delay === undefined) callback();
      return 7;
    };
    globalThis.clearTimeout = function(id) {
      assert.equal(this, globalThis, 'native timers require their global receiver');
      cancelled.push(id);
    };
    globalThis.structuredClone = function(value) {
      assert.equal(this, globalThis, 'native cloning requires its global receiver');
      clones++;
      return nativeClone.call(globalThis, value);
    };
    const page = createSolidsPage(undefined);
    const arena = {lifetime_high_water_mark: 1024, capacity: 2048};
    page.engine.meshOpsWasm = {getArenaMetrics: () => ({tooling_arena: arena,
      tooling_scratch_a: arena, tooling_scratch_b: arena})};
    const stats = fakeElement('p');
    const engine = createSolidsEngine(page, {engineTrapped: () => false}, {
      document: {getElementById: () => stats},
    });
    engine.updateArenaMetrics();
    assert.equal(page.engine.arenaMetricsTimer, 7);
    assert.match(stats.innerText, /Live .*Scratch A .*Scratch B/);
    page.registry.simpleSolids = ['cube'];
    const disposals = [];
    const abort = new AbortController();
    abort.abort();
    const actions = {
      createThumbnailScene: () => ({
        offRenderer: {dispose() {}, forceContextLoss() {}},
        mat: {dispose() {}}, lineMat: {dispose() {}},
        thumbRenderer: {disposeGeometry: () => disposals.push('geometry')},
      }),
    };
    const bases = createSolidsBasePicker(page, actions, {
      document: {getElementById: () => fakeElement('div')},
    });
    await bases.generateThumbnails(abort.signal);
    const gate = createSolidsOpGateView(page, {}, {document: {getElementById: () => stats}});
    gate.showGateMsg('accepted', {persist: false});
    assert.equal(stats.innerText, 'accepted');
    assert.deepEqual(scheduled, [500, undefined, 3000]);
    assert.deepEqual(cancelled, [null]);
    assert.deepEqual(disposals, ['geometry']);
    page.doc.ops = [{op: 'truncate', params: {t: 0.4}}];
    let queued;
    const edits = {queueCommit: callback => { queued = callback; },
      chainIsValid: async () => ({ok: true}), showGateMsg() {}, update() {},
      scheduleUpdate: {cancel() {}}};
    const operations = createSolidsOpsController(page, edits, {
      document: {getElementById: () => ({children: []}), activeElement: null},
    });
    operations.updateOpParam(0, 't', '0.5', page.doc.opsRevision);
    await queued();
    assert.equal(page.doc.ops[0].params.t, 0.5);
    const recipe = {base: 'cube', ops: [{op: 'dual', params: {}}]};
    const saved = createSolidsSavedController(page, {
      showGateMsg() {}, setOps: ops => { page.doc.ops = ops; }, updateToggles() {},
      renderOps() {}, highlightBaseSolid() {}, update() {}, renderBaseSolid() {},
    });
    saved.applyRestore(recipe);
    assert.deepEqual(page.doc.ops, recipe.ops);
    assert.notEqual(page.doc.ops, recipe.ops);
    assert.equal(clones, 2);
  } finally {
    globalThis.setTimeout = nativeTimer;
    globalThis.clearTimeout = nativeClearTimer;
    globalThis.structuredClone = nativeClone;
  }
});
