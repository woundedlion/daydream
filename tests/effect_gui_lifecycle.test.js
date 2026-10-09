import { CHAIN_SNAPSHOT_STORAGE_KEY } from '../src/effects/effect_persistence.js';
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { restoreDocumentAfterEach } from './helpers/fake_dom.js';

import { createEffectGui } from '../src/ui/effect_gui.js';
import { EXPORT_COPIED, EXPORT_FAILED, FLASH_MS } from '../src/ui/effect_actions.js';
import {
  chainSnapshot,
  chainSnapshotParams,
  latticeMeltParams,
  fakeCopyText,
  exportStatus,
  makeHarness,
  SPEED,
  GLOW,
  TELEMETRY,
  pointerDown,
  pointerUp,
  wiring,
  chainParams,
} from './helpers/effect_gui_harness.js';

restoreDocumentAfterEach();

// createEffectGui's Export, mount, drag latch, destroy and external-parameter
// filter, driven over doubles for every injected collaborator.

afterEach(() => { mock.timers.reset(); });

// The Export action copies the live values, and reports the outcome on its own
// button.
test('Export copies the live values as a C++ brace-init list', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.25, 1] });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.25f, true }']);
  assert.equal(h.gui().ctrl('export').label, '\u2713');
  assert.equal(h.gui().ctrl('export').$button.getAttribute('title'), EXPORT_COPIED);
  assert.equal(exportStatus(h).textContent, EXPORT_COPIED);
});

test('the Export outcome is announced in a polite live region', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], copyText: null });
  h.panel.build();
  const status = exportStatus(h);

  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, '');

  h.gui().ctrl('export').object.export();
  assert.equal(status.textContent, EXPORT_FAILED);
  h.gui().ctrl('export').object.export();
  assert.equal(status.textContent, `${EXPORT_FAILED}\u200b`);

  mock.timers.tick(FLASH_MS);
  assert.equal(status.textContent, '',
    'a live region re-announces a repeat only after the text changes');
});

test('ShaderChain Export copies the versioned chain snapshot', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const snapshot = chainSnapshot(0);
  const h = makeHarness({
    params: chainSnapshotParams(), chainSnapshotEnabled: true,
    chainSnapshot: snapshot,
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, [JSON.stringify(snapshot, null, 2)]);
  assert.equal(h.gui().ctrl('export').label, '\u2713');
});

test('Export copies displayed values while a segmented snapshot is pending', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED, GLOW],
    segmentValues: null,
    ownsDisplay: true,
  });
  h.panel.build();
  h.gui().ctrl('Speed').setValue(0.75);
  h.gui().ctrl('Glow').setValue(true);

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.75f, true }']);
  assert.equal(h.gui().ctrl('export').label, '\u2713');
});

test('Export does not fall back to controls from a stale schema', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED],
    segmentValues: null,
    ownsDisplay: true,
    generation: 4,
  });
  h.panel.build();
  h.state.generation = 5;

  h.gui().ctrl('export').object.export();

  assert.deepEqual(h.state.copyText.copied, []);
  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /no parameter values matching/);
});

test('Export omits engine-written readonly params from the preset', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED, TELEMETRY],
    engineValues: [0.25, 1234],
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.25f }']);
});

test('Export without a copy operation reports the failure', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], copyText: null });
  h.panel.build();

  h.gui().ctrl('export').object.export();

  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /clipboard copy unavailable/);
});

test('ShaderChain Export names a missing clipboard operation', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: chainSnapshotParams(),
    chainSnapshotEnabled: true,
    chainSnapshot: { schemaVersion: 2 },
    copyText: null,
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();

  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.deepEqual(h.warnings, ['Export: clipboard copy unavailable']);
});

test('chain Export fails visibly when the typed snapshot is unavailable', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: chainSnapshotParams(),
    chainSnapshotEnabled: true,
    chainSnapshot: null,
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();

  assert.deepEqual(h.state.copyText.copied, []);
  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.deepEqual(h.warnings,
    ['Export: Shader Workbench chain snapshot is unavailable']);
});

test('Export refuses a value stream that has skewed from the panel', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.25] });
  h.panel.build();

  h.gui().ctrl('export').object.export();

  assert.deepEqual(h.state.copyText.copied, []);
  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /param\/value length skew \(2 vs 1\)/);
});

test('a rejected clipboard copy reports the failure', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.25],
    copyText: fakeCopyText(new Error('denied')),
  });
  h.panel.build();

  await h.gui().ctrl('export').object.export();

  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /clipboard copy failed/);
});

test('a copy operation that exhausts its fallbacks reports the failure', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.25],
    copyText: fakeCopyText(false),
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /clipboard copy failed/);
});

test('an Export that lands after an effect switch does not flash the old panel', async () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.25] });
  h.panel.build();
  const stale = h.gui();

  stale.ctrl('export').object.export();
  h.panel.destroy();
  h.panel.build();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.25f }']);
  assert.equal(stale.ctrl('export').label, '\u29c9',
    'the replaced panel is left alone');
});

test('Export reports a parameter formatting failure', () => {
  const h = makeHarness({
    params: [{ name: 'Mode', value: 0, min: 0, max: 1, exportOptions: ['Mode::A'] }],
    engineValues: [1],
  });
  h.panel.build();
  h.gui().ctrl('export').object.export();
  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /parameter formatting failed/);
  assert.deepEqual(h.state.copyText.copied, []);
  h.panel.destroy();
});

test('the Export flash reverts to the default label', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], copyText: null });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  assert.equal(h.gui().ctrl('export').label, '\u2717');

  mock.timers.tick(FLASH_MS);
  assert.equal(h.gui().ctrl('export').label, '\u29c9');
  assert.equal(h.gui().ctrl('export').$button.getAttribute('title'), 'Export');
});

test('destroy cancels a pending Export flash', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], copyText: null });
  h.panel.build();
  const stale = h.gui();

  stale.ctrl('export').object.export();
  h.panel.destroy();
  mock.timers.tick(FLASH_MS);

  assert.equal(stale.ctrl('export').label, '\u2717',
    'the flash timer fired into a destroyed controller');
});

// mount() places the built panel in the page.

test('mount hands the panel to the container as the effect GUI', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();

  h.panel.mount();

  const dom = h.gui().domElement;
  assert.deepEqual(h.container.children, [dom]);
  assert.equal(dom.classList.contains('effect-gui'), true);
  assert.equal(dom.classList.contains('global-gui'), false);
  assert.equal(h.gui().closed, false);
});

test('a mobile layout mounts the panel collapsed', () => {
  const h = makeHarness({ params: [SPEED], isMobile: true });
  h.panel.build();

  h.panel.mount();

  assert.equal(h.gui().closed, true);
});

test('a page with no GUI container mounts nothing', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.state.container = null;

  h.panel.mount();

  assert.equal(h.gui().domElement.parentNode, null);
});

test('mount before build does nothing', () => {
  const h = makeHarness({ params: [SPEED] });

  h.panel.mount();

  assert.deepEqual(h.container.children, []);
});

test('a drag registers window listeners that the pointer release drains', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  const controller = h.gui().ctrl('Speed');

  controller.domElement.dispatch('pointerdown', pointerDown());
  assert.equal(controller.dragging, true);
  assert.deepEqual(h.dragTarget.listeners.map((l) => l.type),
    ['pointerup', 'pointercancel', 'blur']);

  h.dragTarget.dispatch('pointerup', pointerUp());
  assert.equal(controller.dragging, false);
  assert.deepEqual(h.dragTarget.listeners, []);
  assert.equal(h.panel.active().edits.activeDragEnds.size, 0);
});

test('destroy drains the drag listeners of a panel torn down mid-drag', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.gui().ctrl('Speed').domElement.dispatch('pointerdown', pointerDown());

  h.panel.destroy();

  assert.deepEqual(h.dragTarget.listeners, []);
  assert.equal(h.panel.active(), null);
});

test('a slider drag defers persistence to the pointer release', () => {
  const speed = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
  const h = makeHarness({
    params: [speed],
    onEngineParam: (name, value) => { speed.value = value; },
  });
  h.panel.build();
  const controller = h.gui().ctrl('Speed');
  h.gui().storedWrites.length = 0;

  controller.domElement.dispatch('pointerdown', pointerDown());
  controller.setValue(0.2);
  controller.setValue(0.3);

  assert.deepEqual(h.gui().storedWrites, [], 'no per-pointermove persistence');

  h.dragTarget.dispatch('pointerup', pointerUp());

  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.3]]);
});

test('a ShaderChain drag writes one chain snapshot, at the release', () => {
  const snapshot = (hue) => chainSnapshot(hue);
  const h = makeHarness({
    params: chainSnapshotParams(),
    chainSnapshotEnabled: true,
    chainSnapshot: snapshot(0),
    onEngineParam: (name, value, state) => {
      if (name === 'colorize.hue-shift') state.chainSnapshot = snapshot(value);
    },
  });
  h.panel.build();
  const controller = h.gui().ctrl('colorize.hue-shift');
  h.gui().storedWrites.length = 0;

  controller.domElement.dispatch('pointerdown', pointerDown());
  controller.setValue(0.25);
  controller.setValue(0.5);

  assert.deepEqual(h.gui().storedWrites, [], 'no snapshot per pointermove');

  h.dragTarget.dispatch('pointerup', pointerUp());

  assert.deepEqual(h.gui().storedWrites, [
    [CHAIN_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot(0.5))],
  ], 'the release deep-links the state the last move would have');
});
test('a schema rebuild mid-drag still lands the write the drag deferred', () => {
  const speed = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
  const h = makeHarness({
    params: [speed],
    engineValues: [0.1],
    generation: 3,
    onEngineParam: (name, value) => { speed.value = value; },
  });
  h.panel.build();
  h.panel.mount();
  const controller = h.gui().ctrl('Speed');
  const dragged = h.gui();
  dragged.storedWrites.length = 0;

  controller.domElement.dispatch('pointerdown', pointerDown());
  controller.setValue(0.75);

  assert.deepEqual(dragged.storedWrites, [], 'the drag defers the write');

  // The rebuild discards the record the pointer release would have run on.
  h.state.generation = 4;
  h.state.engineValues = [0.75];
  h.panel.sync();

  assert.equal(h.guis.length, 2, 'the schema rebuilt under the drag');
  assert.deepEqual(dragged.storedWrites, [['__accepted.Speed', 0.75]]);
  assert.deepEqual(h.dragTarget.listeners, []);
});

test('a schema rebuild mid-drag lands the whole workbench snapshot', () => {
  const snapshot = (hue) => chainSnapshot(hue);
  const h = makeHarness({
    params: chainSnapshotParams(),
    chainSnapshotEnabled: true,
    chainSnapshot: snapshot(0),
    generation: 3,
    onEngineParam: (name, value, state) => {
      if (name === 'colorize.hue-shift') state.chainSnapshot = snapshot(value);
    },
  });
  h.panel.build();
  h.panel.mount();
  const controller = h.gui().ctrl('colorize.hue-shift');
  const dragged = h.gui();
  dragged.storedWrites.length = 0;

  controller.domElement.dispatch('pointerdown', pointerDown());
  controller.setValue(0.5);
  h.state.generation = 4;
  h.panel.sync();

  assert.equal(h.guis.length, 2, 'the schema rebuilt under the drag');
  assert.deepEqual(dragged.storedWrites, [
    [CHAIN_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot(0.5))],
  ], 'the configuration a reload restores is the dragged one');
});

test('a teardown mid-drag persists the deferred write, and a release only once',
  () => {
    const harness = () => {
      const speed = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
      return makeHarness({
        params: [speed],
        onEngineParam: (name, value) => { speed.value = value; },
      });
    };

    const torn = harness();
    torn.panel.build();
    torn.gui().storedWrites.length = 0;
    torn.gui().ctrl('Speed').domElement.dispatch('pointerdown', pointerDown());
    torn.gui().ctrl('Speed').setValue(0.4);
    torn.panel.destroy();

    assert.deepEqual(torn.gui().storedWrites, [['__accepted.Speed', 0.4]]);

    const released = harness();
    released.panel.build();
    released.gui().storedWrites.length = 0;
    released.gui().ctrl('Speed').domElement.dispatch('pointerdown', pointerDown());
    released.gui().ctrl('Speed').setValue(0.6);
    released.dragTarget.dispatch('pointerup', pointerUp());
    released.panel.destroy();

    assert.deepEqual(released.gui().storedWrites, [['__accepted.Speed', 0.6]],
      'the release cleared the slot the teardown would have flushed');
  });

test('a release that changed no value persists nothing', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.gui().storedWrites.length = 0;

  h.gui().ctrl('Speed').domElement.dispatch('pointerdown', pointerDown());
  h.dragTarget.dispatch('pointerup', pointerUp());

  assert.deepEqual(h.gui().storedWrites, []);
});

test('a toggle persists without waiting for a pointer release', () => {
  const glow = { name: 'Glow', value: false, animated: true };
  const h = makeHarness({
    params: [glow],
    onEngineParam: (name, value) => { glow.value = value > 0.5; },
  });
  h.panel.build();
  h.gui().storedWrites.length = 0;

  h.gui().ctrl('Glow').setValue(true);

  assert.deepEqual(h.gui().storedWrites, [['__accepted.Glow', 1]]);
});

test('a parameter edit persists only that parameter\'s accepted value', () => {
  const speed = { ...SPEED };
  const glow = { ...GLOW };
  const h = makeHarness({
    params: [speed, glow],
    onEngineParam: (name, value) => {
      if (name === speed.name) speed.value = value;
    },
  });
  h.panel.build();
  h.gui().storedWrites.length = 0;

  h.gui().ctrl('Speed').setValue(0.4);

  assert.deepEqual(h.gui().ctrl('Speed').acceptedUrlValues, [0.4]);
  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.4]]);
});

test('a per-keystroke persist re-reads no parameter definitions', () => {
  const speed = { ...SPEED };
  const h = makeHarness({
    params: [speed, { ...GLOW }],
    onEngineParam: (name, value) => {
      if (name === speed.name) speed.value = value;
    },
  });
  h.panel.build();
  const before = h.paramDefinitionReads();

  h.gui().ctrl('Speed').setValue(0.4);
  h.gui().ctrl('Speed').setValue(0.5);

  assert.equal(h.paramDefinitionReads(), before);
  assert.deepEqual(h.gui().storedWrites.slice(-2),
    [['__accepted.Speed', 0.4], ['__accepted.Speed', 0.5]]);
});

test('a refused parameter edit keeps the accepted deep-link value', () => {
  const speed = {
    name: 'Speed', value: 0.2, requestedValue: 0.2, acceptedValue: 0.2,
    min: 0, max: 1, animated: true,
  };
  const h = makeHarness({
    params: [speed],
    onEngineParam: () => false,
  });
  h.panel.build();
  h.gui().storedWrites.length = 0;
  const controller = h.gui().ctrl('Speed');

  controller.setValue(0.8);

  assert.equal(controller.getValue(), 0.8);
  assert.deepEqual(controller.acceptedUrlValues, [0.2]);
  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.2]]);
  assert.deepEqual(h.writes, ['engine:Speed=0.8'],
    'a write refused by the main engine never reaches the segment workers');
});

test('a definition with no accepted value falls back to its requested target', () => {
  const speed = {
    name: 'Speed', value: 0.7, requestedValue: 0.2, min: 0, max: 1, animated: true,
  };
  const h = makeHarness({ params: [speed], onEngineParam: () => false });
  h.panel.build();
  h.gui().storedWrites.length = 0;
  const controller = h.gui().ctrl('Speed');

  assert.equal(controller.getValue(), 0.7, 'the control shows the rendered value');

  controller.setValue(0.8);

  assert.deepEqual(controller.acceptedUrlValues, [0.2],
    'the writable target survives a refused write, not the animation frame');
  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.2]],
    'the rung the whole-list persist writes');
});

test('a drag whose release never lands ends when the window loses focus', () => {
  const warning = 'Speed is faster than the segment stream can follow.';
  const speed = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
  const h = makeHarness({
    params: [speed],
    engineValues: [0.1],
    onEngineParam(name, value, state) {
      state.params = [value > 0.5 ? { ...speed, warning } : { ...speed }];
    },
  });
  h.panel.build();
  h.panel.mount();
  const controller = h.gui().ctrl('Speed');

  controller.domElement.dispatch('pointerdown', pointerDown());
  controller.setValue(0.9);
  h.panel.sync();
  assert.equal(h.guis.length, 1, 'the latch holds the rebuild off mid-gesture');

  // The release the page never sees: it lands on whatever took the focus.
  h.dragTarget.dispatch('blur');

  assert.equal(controller.dragging, false);
  assert.deepEqual(h.dragTarget.listeners, [], 'the end listeners drain');
  assert.equal(h.panel.active().edits.activeDragEnds.size, 0);
  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.9]]);

  h.panel.sync();

  assert.equal(h.guis.length, 2, 'the panel rebuilds again');
  assert.equal(h.gui().ctrl('Speed').domElement
    .querySelector('.param-warning-note').textContent, warning);
});

// A second finger landing while a slider is held must neither re-latch the
// control nor release it: the release the panel acts on is the opening
// pointer's alone.
test('a second pointer neither re-latches a held control nor releases it', () => {
  const speed = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
  const h = makeHarness({
    params: [speed],
    onEngineParam: (name, value) => { speed.value = value; },
  });
  h.panel.build();
  const controller = h.gui().ctrl('Speed');
  h.gui().storedWrites.length = 0;

  controller.domElement.dispatch('pointerdown', pointerDown(3));
  controller.setValue(0.4);
  controller.domElement.dispatch('pointerdown', pointerDown(9));

  assert.deepEqual(h.dragTarget.listeners.map((l) => l.type),
    ['pointerup', 'pointercancel', 'blur'],
    'the second pointer registers no end set of its own');
  assert.equal(h.panel.active().edits.activeDragEnds.size, 1);

  h.dragTarget.dispatch('pointerup', pointerUp(9));

  assert.equal(controller.dragging, true, 'the drag survives the other release');
  assert.deepEqual(h.gui().storedWrites, [], 'nothing is flushed mid-gesture');

  h.dragTarget.dispatch('pointerup', pointerUp(3));

  assert.equal(controller.dragging, false);
  assert.deepEqual(h.dragTarget.listeners, []);
  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.4]]);
});

test('a non-primary or secondary-button pointerdown starts no drag', () => {
  for (const extra of [{ isPrimary: false }, { button: 1 }, { button: 2 }]) {
    const h = makeHarness({ params: [SPEED] });
    h.panel.build();
    const controller = h.gui().ctrl('Speed');

    controller.domElement.dispatch('pointerdown', { ...pointerDown(), ...extra });

    assert.equal(controller.dragging, false, `${JSON.stringify(extra)} must not latch`);
    assert.deepEqual(h.dragTarget.listeners, []);
  }
});

test('a readonly control is never drag-tracked', () => {
  const h = makeHarness({ params: [TELEMETRY] });
  h.panel.build();

  h.gui().ctrl('Frames').domElement.dispatch('pointerdown', pointerDown());

  assert.deepEqual(h.dragTarget.listeners, []);
});

test('toggles and dropdowns are never drag-tracked', () => {
  const mode = { name: 'Mode', value: 0, options: ['Off', 'On'] };
  const h = makeHarness({ params: [GLOW, mode] });
  h.panel.build();

  h.gui().ctrl('Glow').domElement.dispatch('pointerdown', pointerDown());
  h.gui().ctrl('Mode').domElement.dispatch('pointerdown', pointerDown());

  assert.deepEqual(h.dragTarget.listeners, []);
});

// destroy() must leave nothing of the panel behind.
test('destroy detaches the panel DOM and tears the GUI down', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.panel.mount();
  const gui = h.gui();

  h.panel.destroy();

  assert.deepEqual(h.container.children, []);
  assert.equal(gui.domElement.parentNode, null);
  assert.equal(gui.destroyed, 1);
  assert.equal(h.panel.active(), null);
  assert.deepEqual(h.warnings, []);
});

test('a lil-gui teardown fault still clears the panel', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.gui().destroyThrows = new Error('lil-gui blew up');

  h.panel.destroy();

  assert.equal(h.panel.active(), null);
  assert.match(h.warnings[0], /GUI destroy warning/);
});

test('destroy on an unbuilt panel is a no-op', () => {
  const h = makeHarness({ params: [SPEED] });

  h.panel.destroy();

  assert.equal(h.panel.active(), null);
  assert.deepEqual(h.warnings, []);
});

// The chain editor's external-parameter filter.

// External parameters retain their slots in the positional value stream.
test('the external filter builds no parameter controls', () => {
  const params = chainParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });
  h.state.paramFilter = { external: true };

  h.panel.build();
  const fx = h.panel.active();

  assert.deepEqual([...fx.controllerByName.keys()], []);
  assert.deepEqual(fx.paramNames, params.map((parameter) => parameter.name),
    'the value-stream order stays whole');
  assert.equal(fx.hasParams, false, 'nothing to sync per frame');
});

test('a filter change rebuilds the panel on the next sync', () => {
  const params = chainParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });
  h.panel.build();
  assert.equal(h.panel.active().controllerByName.has('camera.wander'), true);

  h.state.paramFilter = { external: true };
  h.panel.sync();
  assert.equal(h.panel.active().controllerByName.has('camera.wander'), false);
  assert.equal(h.panel.active().controllerByName.has('sample.pattern-freq'), false);

  h.state.paramFilter = null;
  h.panel.sync();
  assert.equal(h.panel.active().controllerByName.has('camera.wander'), true,
    'clearing the filter restores the unfiltered panel');
});

test('readonly enum type-ahead cannot move the visible selection', () => {
  const h = makeHarness({ params: [{ name: 'Mode', value: 0,
    options: ['Off', 'On', 'Auto'], readonly: true }] });
  h.panel.build();
  const control = h.gui().ctrl('Mode');
  for (const key of ['a', 'O', '1', ' ']) {
    assert.equal(control.$select.dispatch('keydown', { key }).defaultPrevented, true);
  }
  assert.equal(control.$select.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  assert.equal(control.$select.dispatch('click').defaultPrevented, true);
});

test('readonly enum changes restore the display before target handlers run', () => {
  const h = makeHarness({ params: [{ name: 'Mode', value: 0,
    options: ['Off', 'On'], readonly: true }] });
  h.panel.build();
  const control = h.gui().ctrl('Mode');
  let bubbled = false;
  control.$select.addEventListener('change', () => { bubbled = true; });
  const updates = control.displayUpdates;
  control.$select.dispatch('change');
  assert.equal(bubbled, false);
  assert.equal(control.displayUpdates, updates + 1);
});

test('externally rendered stage parameters build no stage folders', () => {
  const params = latticeMeltParams();
  const h = makeHarness({ params, engineValues: params.map((parameter) => parameter.value) });
  h.state.paramFilter = { external: true };
  h.panel.build();
  assert.equal(h.panel.active().stageFolders.size, 0);
  assert.deepEqual(h.panel.active().paramNames, params.map((parameter) => parameter.name));
});

test('segmented enums follow the lagging pool values', () => {
  const h = makeHarness({
    params: [{ name: 'Mode', value: 0, requestedValue: 2,
      options: ['A', 'B', 'C'], animated: true }],
    engineValues: [2], segmentValues: [0], ownsDisplay: true,
  });
  h.panel.build();
  h.panel.sync();
  assert.equal(h.gui().ctrl('Mode').getValue(), 0);
  h.state.segmentValues = [1.6];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Mode').getValue(), 2);
});

test('an applied chain restore clears the import notice', () => {
  const stored = chainSnapshot();
  const h = makeHarness({ params: chainParams(), chainSnapshotEnabled: true,
    chainSnapshot: stored, acceptedStored: { [CHAIN_SNAPSHOT_STORAGE_KEY]: JSON.stringify(stored) } });
  h.panel.build();
  assert.deepEqual(h.restoredChainSnapshots, [stored]);
  assert.deepEqual(h.configNotices, [null]);
});

test('a failed initial panel build reports an unavailable control panel', () => {
  const h = makeHarness({ params: null });
  h.panel.build();
  assert.equal(h.panel.active(), null);
  assert.deepEqual(h.configNotices, ['Effect controls could not be built.']);
  assert.match(h.warnings[0], /panel construction failed/);
  assert.equal(h.guis[0].destroyed, 1);
});

for (const rebuild of [false, true]) test(`panel ${rebuild ? 'rebuild' : 'build'} propagates module death`, () => {
  const deps = wiring();
  const trap = new WebAssembly.RuntimeError('unreachable');
  let dead = false;
  deps.engine.getParameterDefinitions = () => { if (dead) throw trap; return []; };
  deps.engine.paramGeneration = () => dead ? 2 : 1;
  const panel = createEffectGui({ ...deps, moduleDead: (error) => error === trap });
  if (rebuild) panel.build();
  dead = true;
  assert.throws(() => rebuild ? panel.sync() : panel.build(), (error) => error === trap);
});

test('preset advancement refreshes nonanimated requested selectors', () => {
  const mode = { name: 'Mode', value: 0, requestedValue: 0, options: ['Off', 'On'], animated: false };
  const h = makeHarness({ params: [mode], engineValues: [0], presetCount: 3, presetIndex: 0 });
  h.panel.build();
  h.state.params = [{ ...mode, requestedValue: 1 }];
  h.state.presetIndex = 1;
  h.panel.sync();
  assert.equal(h.gui().ctrl('Mode').getValue(), 1);
});

for (const chainSnapshotEnabled of [false, true]) test(`preset selection ${chainSnapshotEnabled ? 'keeps' : 'clears'} stored writable values (chainSnapshotEnabled=${chainSnapshotEnabled})`, () => {
  const h = makeHarness({ params: [SPEED, TELEMETRY], presetCount: 3, chainSnapshotEnabled,
    chainSnapshot: chainSnapshot() });
  h.panel.build();
  h.gui().storedWrites.length = 0;
  assert.equal(h.panel.movePreset(1), true);
  const cleared = h.gui().storedWrites.filter(([, value]) => value === null).map(([name]) => name);
  assert.deepEqual(cleared, chainSnapshotEnabled ? [] : ['Speed']);
});


test('sparse enum controls roundtrip numeric IDs and reject gaps before a write', () => {
  const parameter = { name: 'Pattern', value: 0, requestedValue: 6, acceptedValue: 0,
    options: ['Cubic', 'Octet Truss', 'Shells'], optionValues: [0, 1, 6], animated: true };
  const h = makeHarness({ params: [parameter], engineValues: [6] });
  h.panel.build();
  const controller = h.gui().ctrl('Pattern');
  assert.deepEqual({ ...controller.args[0] }, { Cubic: 0, 'Octet Truss': 1, Shells: 6 });
  assert.equal(controller.getValue(), 6);
  for (const value of [0, 1, 6]) {
    controller.setValue(value);
    assert.equal(controller.getValue(), value);
  }
  assert.ok(h.writes.includes('engine:Pattern=6'));
  assert.ok(h.writes.includes('worker:Pattern=6'));
  const before = h.writes.length;
  controller.setValue(2);
  assert.equal(controller.getValue(), 6);
  assert.equal(h.writes.length, before);
  parameter.requestedValue = 1;
  h.panel.sync();
  assert.equal(controller.getValue(), 1);
  h.state.ownsDisplay = true;
  h.state.segmentValues = [6];
  h.panel.sync();
  assert.equal(controller.getValue(), 6);
});
