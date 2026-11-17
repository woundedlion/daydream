// createEffectGui harness: doubles for every injected collaborator plus the
// parameter fixtures the effect_gui suites share.
import { fakePanelGui } from './fake_gui.js';
import { createEffectGui } from '../../src/ui/effect_gui.js';
import { fakeElement, installDocument } from './fake_dom.js';
import { ChainSnapshotRestoreResult } from './fake_engine.js';
import { CHAIN_SNAPSHOT_SCHEMA_VERSION } from '../../src/workbench/shader/shader_deeplink.js';

export function chainSnapshot(value = 0) {
  return {
    schemaVersion: CHAIN_SNAPSHOT_SCHEMA_VERSION,
    modulation: [],
    chain: [
      {instance: 'project', operator: 'project.stereographic.v2'},
      {instance: 'sample', operator: 'sample.grid.v4'},
      {instance: 'colorize', operator: 'colorize.generated-palette.v4'},
    ],
    parameters: [{name: 'sample.edge-width', value}],
    animationsPaused: true,
  };
}

export function chainSnapshotParams() {
  return [...chainParams(),
    { name: 'colorize.hue-shift', value: 0, min: 0, max: 1, animated: true },
  ];
}

function groupedParams(groups) {
  return groups.flatMap(([group, names]) => names.map(name =>
    ({name, group, value: 0.5, min: 0, max: 1, animated: true})));
}

export function kaleidoscopeMeltParams() {
  return groupedParams([
    [{name: 'Function', title: 'Tessellation', order: 7}, [
      'Cell Scale',
      'Cell Shape',
      'Cell Softness',
      'Cell Radius',
    ]],
    [{name: 'Projection', title: 'Equirectangular', order: 4}, [
      'Central Meridian',
    ]],
    [{name: 'Projection Frame', title: 'Spin + Wander', order: 3}, [
      'Projection Spin Speed',
      'Projection Wander',
    ]],
    [{name: 'Camera', title: 'Camera', order: 0}, [
      'Camera Wander',
    ]],
    [{name: 'Surface Noise', title: 'Curl', order: 2}, [
      'Surface Noise Scale',
      'Surface Noise Strength',
      'Surface Noise Speed',
    ]],
    [{name: 'Colorize', title: 'Generated Analogous', order: 10}, [
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
    ]],
  ]);
}

export function kaleidoscopeSmoothParams() {
  return groupedParams([
    [{name: 'Function', title: 'Grid', order: 7}, [
      'Pattern Freq',
      'Speed',
      'Complexity',
      'Pattern Mix',
    ]],
    [{name: 'Projection', title: 'Stereographic', order: 4}, [
      'Singularity Fade',
    ]],
    [{name: 'Projection Frame', title: 'Spin + Wander', order: 3}, [
      'Projection Spin Speed',
      'Projection Wander',
    ]],
    [{name: 'Camera', title: 'Camera', order: 0}, [
      'Camera Wander',
    ]],
    [{name: 'Planar Warp 2', title: 'Mirror + Affine', order: 6}, [
      'Planar Warp 2 Speed',
      'Mirror Rotation',
      'Mirror Cell X',
      'Mirror Cell Y',
      'Mirror Offset X',
      'Mirror Offset Y',
      'Planar Warp Speed',
      'Affine Rotation Rate',
      'Repeat Windings A',
      'Repeat Windings B',
      'Affine Scale X',
      'Affine Scale Y',
      'Affine Shear',
      'Repeat Cells',
      'Fallback Lattice Period',
    ]],
    [{name: 'Colorize', title: 'Generated Analogous', order: 10}, [
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
    ]],
  ]);
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

/** @param {Object} ctrl @returns {string|null} The Export button's accessible name. */
export const exportName = (ctrl) => ctrl.$button.getAttribute('aria-label');

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
 * @param {Object[]} [options.params] - Engine parameter descriptors.
 * @param {number[]} [options.engineValues] - Engine parameter values.
 * @param {number[]|null} [options.segmentValues] - Worker parameter values.
 * @param {boolean} [options.ownsDisplay] - Worker display ownership.
 * @param {number} [options.generation] - Parameter descriptor generation.
 * @param {Function|null} [options.copyText] - Clipboard copy operation, if available.
 * @param {boolean} [options.isMobile] - Mobile panel layout.
 * @param {Function} [options.canPausePresets] - Preset pause availability.
 * @param {Object} [options.container] - Panel mount element.
 * @param {Object} [options.hydrated] - GUI values restored on construction.
 * @param {Object} [options.acceptedStored] - Stored values accepted by the GUI.
 * @param {(p: Object) => boolean} [options.pausesOnWrite] - Engine pause rule.
 * @param {Function} [options.onEngineParam] - Parameter-write reaction; false refuses.
 * @param {Function} [options.onReadAdvisories] - Advisory-read reaction.
 * @param {boolean} [options.rebuildOnApply] - Rebuilds the panel when applying.
 * @param {Function} [options.onSynchronizePreset] - Preset-sync reaction.
 * @param {number} [options.presetCount] - Available preset count.
 * @param {number} [options.presetIndex] - Selected preset index.
 * @param {boolean} [options.presetSelectionAccepted] - Accepts preset selection.
 * @param {boolean} [options.presetSyncAccepted] - Accepts preset synchronization.
 * @param {boolean} [options.chainSnapshotEnabled] - Enables chain configuration.
 * @param {Object|null} [options.chainSnapshot] - Initial chain configuration.
 * @param {boolean} [options.restoreChainSnapshotAccepted] - Accepts chain restore.
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
  canPausePresets = () => true,
  container = fakeElement('div', { connected: true }),
  hydrated = {},
  acceptedStored = {},
  pausesOnWrite = (p) => Boolean(p.animated),
  onEngineParam = () => {},
  onReadAdvisories = () => {},
  rebuildOnApply = false,
  onSynchronizePreset = () => {},
  presetCount = 0,
  presetIndex = 0,
  presetSelectionAccepted = true,
  presetSyncAccepted = true,
  chainSnapshotEnabled = false,
  chainSnapshot: initialChainSnapshot = null,
  restoreChainSnapshotAccepted = true,
} = {}) {
  installDocument({ body: fakeElement('body', { connected: true }), activeElement: null });
  const state = {
    advisories: [],
    advisoryReads: 0,
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
    chainSnapshot: initialChainSnapshot,
  };
  const writes = [];
  const warnings = [];
  const restoredChainSnapshots = [];
  const controllersAtRestore = [];
  const configNotices = [];
  const actionNotices = [];
  let paramDefinitionReads = 0;
  const guis = [];
  const dragTarget = fakeElement('window');
  // Engine double: owns the animation-pause state the panel reads back,
  // driven by the same two writes the real engine drives it with.
  const engine = { paused: false };

  const panel = createEffectGui({
    engine: {
      getParameterDefinitions: () => { paramDefinitionReads += 1; return state.params; },
      getParameterAdvisories: () => {
        state.advisoryReads += 1;
        onReadAdvisories(state);
        return state.advisories;
      },
      paramGeneration: () => state.generation,
      paramValues: () => state.engineValues,
      setParam: (name, value) => {
        writes.push(`engine:${name}=${value}`);
        const p = state.params.find((d) => d.name === name);
        const accepted = onEngineParam(name, value, state) !== false;
        if (accepted && p && pausesOnWrite(p)) engine.paused = true;
        return accepted;
      },
      setAnimationsPaused: (paused) => {
        writes.push(`paused:${paused}`);
        engine.paused = paused;
      },
      animationsPaused: () => engine.paused,
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
        if (!restoreChainSnapshotAccepted || !Number.isInteger(snapshot.schemaVersion))
          return ChainSnapshotRestoreResult.INVALID_VALUE;
        return snapshot.schemaVersion === CHAIN_SNAPSHOT_SCHEMA_VERSION
          ? ChainSnapshotRestoreResult.APPLIED : ChainSnapshotRestoreResult.UNSUPPORTED_VERSION;
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
      canPausePresets,
      copyText: state.copyText,
      showActionNotice: (message) => actionNotices.push(message),
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
           restoredChainSnapshots, controllersAtRestore, configNotices, actionNotices,
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
