// createEffectGui harness: doubles for every injected collaborator plus the
// parameter fixtures the effect_gui suites share.
import { fakePanelGui } from './fake_app.js';
import { createEffectGui } from '../../src/ui/effect_gui.js';
import { fakeElement, installDocument } from './fake_dom.js';
import { ChainSnapshotRestoreResult } from './fake_engine.js';

export function chainSnapshot(value = 0) {
  return {
    schemaVersion: 2,
    chain: [
      {instance: 'project', operator: 'project.stereographic.v2'},
      {instance: 'sample', operator: 'sample.grid.v3'},
      {instance: 'colorize', operator: 'colorize.generated-palette.v3'},
    ],
    parameters: [{name: 'sample.pattern-freq', value}],
    animationsPaused: true,
  };
}

export function chainSnapshotParams() {
  return [...chainParams(),
    { name: 'colorize.hue-shift', value: 0, min: 0, max: 1, animated: true },
  ];
}

export function latticeMeltParams() {
  return [
    'Lattice Cell Scale',
    'Lattice Shape',
    'Lattice Softness',
    'Lattice Radius',
    'Central Meridian',
    'Projection Spin Speed',
    'Projection Wander',
    'Camera Wander',
    'Surface Noise Scale',
    'Surface Noise Strength',
    'Surface Noise Speed',
    'Palette Chroma',
    'Palette Mapping',
    'Mapping Frequency',
    'Mapping Phase',
    'Phase Oscillation Depth',
    'Phase Oscillation Speed',
    'Brightness Bottom',
    'Brightness Top',
    'Opacity at Value 0',
    'Opacity at Value 1',
    'Hue Shift Amount',
    'Hue Noise Scale',
    'Hue Noise Speed',
  ].map((name) => ({ name, value: 0.5, min: 0, max: 1, animated: true }));
}

export function kaleidoscopeSmoothParams() {
  return [
    'Pattern Freq',
    'Speed',
    'Source Angle Speed',
    'Complexity',
    'Pattern Mix',
    'Drift',
    'Singularity Fade',
    'Projection Spin Speed',
    'Projection Wander',
    'Camera Wander',
    'Planar Warp 2 Speed',
    'Mirror Rotation',
    'Mirror Cell X',
    'Mirror Cell Y',
    'Mirror Offset X',
    'Mirror Offset Y',
    'Palette Chroma',
    'Palette Mapping',
    'Mapping Frequency',
    'Mapping Phase',
    'Phase Oscillation Depth',
    'Phase Oscillation Speed',
    'Opacity at Value 0',
    'Opacity at Value 1',
    'Hue Shift Amount',
    'Hue Noise Scale',
    'Hue Noise Speed',
  ].map((name) => ({ name, value: 0.5, min: 0, max: 1, animated: true }));
}

/**
 * Clipboard copy double that resolves, fails, or rejects on demand.
 * @param {boolean|Error} [outcome] - Resolution value or rejection value.
 * @returns {Function} The copy operation, carrying the copied texts.
 */
export function fakeCopyText(outcome = true) {
  const copied = [];
  const copyText = (text) => {
    copied.push(text);
    return outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  };
  copyText.copied = copied;
  return copyText;
}

/**
 * The live region the action row announces an Export outcome through.
 * @param {Object} h - A built harness.
 * @returns {Object} The status element.
 */
export function exportStatus(h) {
  return h.gui().$children.children[0].querySelector('.visually-hidden');
}

/**
 * Build the module under test over doubles for every collaborator.
 * @param {Object} [options] - Engine/page state the panel reads.
 * @param {(p: Object) => boolean} [options.pausesOnWrite] - The engine's implicit
 *   pause rule, applied by the setEngineParam double: which parameter writes
 *   leave the engine reporting paused animations.
 * @param {boolean} [options.pauseAccessor] - False models a module that does not
 *   export getAnimationsPaused.
 * @param {Function} [options.onEngineParam] - Optional engine-side reaction to
 *   a parameter write, used to model a dynamic descriptor rebind; returning
 *   false models an engine refusal.
 * @param {boolean} [options.rebuildOnApply] - Makes the injected applyEffect run
 *   the app's real destroy/build/mount sequence instead of only recording the
 *   call, which is what the Reset button drives.
 * @returns {Object} The panel plus the doubles and sinks a test asserts on.
 */
export function makeHarness({
  params = [],
  engineValues = [],
  segmentValues = null,
  ownsDisplay = false,
  generation = 1,
  copyText = fakeCopyText(),
  isMobile = false,
  container = fakeElement('div', { connected: true }),
  hydrated = {},
  acceptedStored = {},
  pausesOnWrite = (p) => Boolean(p.animated),
  pauseAccessor = true,
  onEngineParam = () => {},
  rebuildOnApply = false,
  onSynchronizePreset = () => {},
  presetCount = 0,
  presetIndex = 0,
  presetSelectionAccepted = true,
  presetSyncAccepted = true,
  chainSnapshotEnabled = false,
  chainSnapshot = null,
  restoreChainSnapshotAccepted = true,
} = {}) {
  installDocument({ body: fakeElement('body', { connected: true }), activeElement: null });
  const state = {
    params,
    focused: null,
    paramFilter: null,
    generation,
    engineValues,
    segmentValues,
    ownsDisplay,
    copyText,
    container,
    presetCount,
    presetIndex,
    hostPresetIndex: presetIndex,
    chainSnapshot,
  };
  const writes = [];
  const warnings = [];
  const restoredChainSnapshots = [];
  const controllersAtRestore = [];
  const configNotices = [];
  let paramDefinitionReads = 0;
  const guis = [];
  const dragTarget = fakeElement('window');
  // Engine double: owns the animation-pause state the panel reads back,
  // driven by the same two writes the real engine drives it with.
  const engine = { paused: false };

  const panel = createEffectGui({
    engine: {
      getParameterDefinitions: () => { paramDefinitionReads += 1; return state.params; },
      paramGeneration: () => state.generation,
      paramValues: () => state.engineValues,
      setParam: (name, value) => {
        writes.push(`engine:${name}=${value}`);
        const p = state.params.find((d) => d.name === name);
        if (p && pausesOnWrite(p)) engine.paused = true;
        return onEngineParam(name, value, state) !== false;
      },
      setAnimationsPaused: (paused) => {
        writes.push(`paused:${paused}`);
        engine.paused = paused;
      },
      animationsPaused: () => (pauseAccessor ? engine.paused : undefined),
      getPresetCount: () => state.presetCount,
      getPresetIndex: () => state.presetIndex,
      synchronizePreset: (index) => {
        if (state.hostPresetIndex === index) return true;
        if (!presetSyncAccepted) return false;
        writes.push(`syncPreset:${index}`);
        state.hostPresetIndex = index;
        onSynchronizePreset(index, state);
        return true;
      },
      selectPreset: (index) => {
        writes.push(`preset:${index}`);
        if (!presetSelectionAccepted) return false;
        state.presetIndex = index;
        state.hostPresetIndex = index;
        engine.paused = true;
        return true;
      },
    },
    segments: {
      ownsDisplay: () => state.ownsDisplay,
      paramValues: () => state.segmentValues,
      setParam: (name, value) => writes.push(`worker:${name}=${value}`),
    },
    config: {
      inUse: () => chainSnapshotEnabled,
      snapshot: () => state.chainSnapshot,
      restore: (snapshot) => {
        restoredChainSnapshots.push(snapshot);
        controllersAtRestore.push(guis.at(-1).controllers.length);
        return restoreChainSnapshotAccepted && snapshot.schemaVersion === 2
          ? ChainSnapshotRestoreResult.APPLIED : ChainSnapshotRestoreResult.INVALID_VALUE;
      },
      restoreResults: () => ChainSnapshotRestoreResult,
      showImportNotice: (message) => configNotices.push(message),
    },
    host: {
      createGui: () => {
        const gui = fakePanelGui({ hydrated, stored: acceptedStored });
        guis.push(gui);
        return gui;
      },
      container: () => state.container,
      isMobile: () => isMobile,
      copyText: state.copyText,
      applyEffect: () => {
        writes.push('applyEffect');
        if (!rebuildOnApply) return;
        panel.destroy();
        panel.build();
        panel.mount();
      },
      dragTarget,
      focusedElement: () => state.focused,
      paramFilter: () => state.paramFilter,
      logWarn: (...args) => warnings.push(args.join(' ')),
    },
  });

  return { panel, state, writes, warnings, guis, dragTarget, container, engine,
           restoredChainSnapshots, controllersAtRestore, configNotices,
           paramDefinitionReads: () => paramDefinitionReads,
           gui: () => guis[guis.length - 1] };
}

export const SPEED = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
export const GLOW = { name: 'Glow', value: false, animated: true };
export const TELEMETRY = { name: 'Frames', value: 0, min: 0, max: 99, readonly: true };

/** A pointerdown the drag latch accepts. @returns {Object} The event fields. */
export const pointerDown = (pointerId = 3) => ({ pointerId, isPrimary: true, button: 0 });
/** The release of one pointer. @returns {Object} The event fields. */
export const pointerUp = (pointerId = 3) => ({ pointerId });

/**
 * A wiring createEffectGui accepts, carrying every member it demands and none
 * of the optional config group.
 * @returns {Object} The three demanded collaborators (engine, segments, host).
 */
export const wiring = () => ({
  engine: {
    getParameterDefinitions: () => [],
    paramGeneration: () => 1,
    paramValues: () => null,
    setParam: () => true,
    setAnimationsPaused: () => {},
    animationsPaused: () => false,
    getPresetCount: () => 0,
    getPresetIndex: () => 0,
    synchronizePreset: () => true,
    selectPreset: () => true,
  },
  segments: {
    ownsDisplay: () => false,
    paramValues: () => null,
    setParam: () => {},
  },
  host: {
    createGui: () => fakePanelGui(),
    container: () => null,
    isMobile: () => false,
    applyEffect: () => {},
    dragTarget: fakeElement('window'),
    copyText: null,
  },
});

export function chainParams() {
  return [
    { name: 'camera.wander', value: 0, min: 0, max: 1, animated: true },
    { name: 'sample.pattern-freq', value: 1, min: 0.1, max: 20, animated: true },
    { name: 'sample.coverage-mode', value: 1, requestedValue: 1,
      options: ['none', 'weight', 'weight-squared', 'edge-fade'] },
    { name: 'sample.edge-width', value: 0.1, min: 0, max: 1, animated: true },
  ];
}
