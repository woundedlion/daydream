import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApplyPipeline,
  planResolutionApply,
  runSwitchTransaction,
  applyInitialState,
  ApplyResult,
  snapshotEffectControlState,
  restoreEffectControlState,
  offeredResolutions,
  resolutionCorrection,
  resolutionEffects,
  switchFailureReport,
} from '../effect_sequencing.js';
import { EffectSetResult, ResolutionSetResult } from './fake_engine.js';

function makeEffectControls(values, paused = false, sinks = null) {
  const state = { ...values };
  const animationState = { pause: paused };
  const controllerByName = new Map();
  for (const name of Object.keys(values)) {
    controllerByName.set(name, {
      getValue: () => state[name],
      setValue: (value) => {
        state[name] = value;
        if (sinks) {
          sinks.engine[name] = value;
          sinks.workers[name] = value;
          sinks.url[name] = value;
          sinks.events.push(`param:${name}`);
        }
      },
    });
  }
  const pauseController = {
    setValue: (value) => {
      animationState.pause = value;
      if (sinks) {
        sinks.engine.paused = value;
        sinks.workers.paused = value;
        sinks.url.paused = value;
        sinks.events.push(`pause:${value}`);
      }
    },
  };
  return {
    state,
    pause: { animationState, controller: pauseController },
    controllerByName,
    writableParamNames: Object.keys(values).filter((name) => name !== 'Telemetry'),
  };
}

function makeSinks() {
  return { engine: {}, workers: {}, url: {}, events: [] };
}

test('effect state snapshot copies writable controls and pause state', () => {
  const effect = makeEffectControls({ Speed: 0.75, Glow: true, Telemetry: 42 }, true);
  const snapshot = snapshotEffectControlState(effect);

  effect.state.Speed = 0.1;
  effect.pause.animationState.pause = false;

  assert.deepEqual(snapshot, {
    paramValues: [['Speed', 0.75], ['Glow', true]],
    animationsPaused: true,
  });
});

test('a full-config effect snapshots no parameters to replay', () => {
  const effect = makeEffectControls({ Speed: 0.75, Glow: true }, true);

  const snapshot = snapshotEffectControlState(effect, () => true);

  assert.deepEqual(snapshot, { paramValues: [], animationsPaused: true },
    'the panel rebuild restores the effect whole, so a per-parameter replay on '
    + 'top of it would only drive it through combinations the bridge refuses');
});

test('effect state restoration updates controls, engine, workers, and URL together', () => {
  const snapshot = snapshotEffectControlState(
    makeEffectControls({ Speed: 0.75, Glow: true }, true));
  const sinks = makeSinks();
  const rebuilt = makeEffectControls({ Speed: 0.1, Glow: false }, false, sinks);

  restoreEffectControlState(rebuilt, snapshot);

  const expected = { Speed: 0.75, Glow: true, paused: true };
  assert.deepEqual({ ...rebuilt.state, paused: rebuilt.pause.animationState.pause }, expected);
  assert.deepEqual(sinks.engine, expected);
  assert.deepEqual(sinks.workers, expected);
  assert.deepEqual(sinks.url, expected);
  assert.equal(sinks.events[0], 'pause:true');
});

test('one effect snapshot survives nested effect and resolution rollback', () => {
  const snapshot = snapshotEffectControlState(
    makeEffectControls({ Speed: 0.9, Glow: true }, false));
  const effectSinks = makeSinks();
  const resolutionSinks = makeSinks();
  const effectRollback = makeEffectControls({ Speed: 0.1, Glow: false }, true, effectSinks);
  const resolutionRollback = makeEffectControls(
    { Speed: 0.2, Glow: false }, true, resolutionSinks);

  restoreEffectControlState(effectRollback, snapshot);
  restoreEffectControlState(resolutionRollback, snapshot);

  const expected = { Speed: 0.9, Glow: true, paused: false };
  assert.deepEqual(effectSinks.engine, expected);
  assert.deepEqual(effectSinks.workers, expected);
  assert.deepEqual(effectSinks.url, expected);
  assert.deepEqual(resolutionSinks.engine, expected);
  assert.deepEqual(resolutionSinks.workers, expected);
  assert.deepEqual(resolutionSinks.url, expected);
});

test('initial state dismisses the loader only after a successful apply', () => {
  const events = [];

  applyInitialState(
    () => { events.push('apply'); return ApplyResult.APPLIED; },
    () => { events.push('dismiss'); },
  );

  assert.deepEqual(events, ['apply', 'dismiss']);
});

test('a rejected initial state keeps the loader visible and throws', () => {
  let dismissed = false;

  assert.throws(
    () => applyInitialState(() => ApplyResult.REJECTED, () => { dismissed = true; }),
    /initialization was rejected/,
  );
  assert.equal(dismissed, false);
});

test('a thrown initial state keeps the loader visible and propagates the error', () => {
  const failure = new Error('initial apply failed');
  let dismissed = false;

  assert.throws(
    () => applyInitialState(() => { throw failure; }, () => { dismissed = true; }),
    failure,
  );
  assert.equal(dismissed, false);
});

test('a successful switch leaves the previous applied state untouched', () => {
  let rollbacks = 0;
  const result = runSwitchTransaction(() => ApplyResult.APPLIED, () => { rollbacks++; });

  assert.deepEqual(result, { applied: true, failure: null, recoveryFailure: null });
  assert.equal(rollbacks, 0);
});

test('a rejected switch restores the previous applied state', () => {
  let restored = false;
  const result = runSwitchTransaction(() => ApplyResult.REJECTED, () => { restored = true; });

  assert.deepEqual(result, { applied: false, failure: null, recoveryFailure: null });
  assert.equal(restored, true);
});

test('a thrown switch restores the previous applied state and reports the failure', () => {
  const failure = new Error('switch failed');
  let restored = false;
  const result = runSwitchTransaction(
    () => { throw failure; },
    () => { restored = true; },
  );

  assert.equal(result.applied, false);
  assert.equal(result.failure, failure);
  assert.equal(result.recoveryFailure, null);
  assert.equal(restored, true);
});

test('a rollback failure is surfaced separately from the switch failure', () => {
  const failure = new Error('switch failed');
  const recoveryFailure = new Error('rollback failed');
  const result = runSwitchTransaction(
    () => { throw failure; },
    () => { throw recoveryFailure; },
  );

  assert.equal(result.applied, false);
  assert.equal(result.failure, failure);
  assert.equal(result.recoveryFailure, recoveryFailure);
});

// planResolutionApply is the DOM/engine-free core of applyResolution()'s
// re-apply decision: keep the requested effect when the resolution offers it,
// else fall back to the list head.

test('an offered effect is kept', () => {
  assert.deepEqual(
    planResolutionApply(['A', 'B', 'C'], 'B'),
    { nextEffect: 'B', effectChanged: false });
});

test('an off-list effect falls back to the first entry', () => {
  assert.deepEqual(
    planResolutionApply(['A', 'B', 'C'], 'Z'),
    { nextEffect: 'A', effectChanged: true });
});

test('the first entry itself is kept', () => {
  assert.deepEqual(
    planResolutionApply(['A', 'B', 'C'], 'A'),
    { nextEffect: 'A', effectChanged: false });
});

test('every offered effect is kept unchanged', () => {
  for (const cur of ['A', 'B', 'C']) {
    assert.equal(planResolutionApply(['A', 'B', 'C'], cur).effectChanged, false);
  }
});

// offeredResolutions keeps the resolution dropdown to the rows the engine
// reports through getSupportedResolutions().

const PRESETS = {
  'Holosphere (96x20)': { h: 20, w: 96, dotSize: 2 },
  'Phantasm (288x144)': { h: 144, w: 288, dotSize: 0.25 },
};

test('every preset is offered when the engine reports nothing', () => {
  const all = Object.keys(PRESETS);
  for (const supported of [null, undefined, []]) {
    assert.deepEqual(offeredResolutions(PRESETS, supported),
      { labels: all, unlabeled: [] });
  }
});

test('a preset the engine no longer builds is dropped', () => {
  assert.deepEqual(offeredResolutions(PRESETS, [[96, 20]]),
    { labels: ['Holosphere (96x20)'], unlabeled: [] });
});

test('offered labels keep the preset table order', () => {
  assert.deepEqual(offeredResolutions(PRESETS, [[288, 144], [96, 20]]).labels,
    ['Holosphere (96x20)', 'Phantasm (288x144)']);
});

test('an engine row no preset covers is reported, not offered', () => {
  assert.deepEqual(offeredResolutions(PRESETS, [[96, 20], [64, 32]]),
    { labels: ['Holosphere (96x20)'], unlabeled: ['64x32'] });
});

test('a wholly unmatched engine list leaves every preset offered', () => {
  assert.deepEqual(offeredResolutions(PRESETS, [[64, 32]]),
    { labels: Object.keys(PRESETS), unlabeled: [] });
});

// resolutionCorrection decides whether syncResolutionOptions() must move the
// hydrated resolution onto the offered list.

test('an offered resolution needs no correction', () => {
  for (const label of Object.keys(PRESETS)) {
    assert.equal(resolutionCorrection(Object.keys(PRESETS), label), null);
  }
});

test('a resolution the engine dropped is corrected to the first offered label', () => {
  assert.equal(
    resolutionCorrection(['Holosphere (96x20)'], 'Phantasm (288x144)'),
    'Holosphere (96x20)');
});

test('an empty offer list yields no correction', () => {
  assert.equal(resolutionCorrection([], 'Phantasm (288x144)'), null);
});

// resolutionEffects is applyResolution()/Test All's per-resolution effect list.

test('a preset reports its own effect list', () => {
  const presets = { Lo: { favorites: ['A', 'B'] }, Hi: { favorites: ['C'] } };
  assert.deepEqual(resolutionEffects(presets, 'Lo'), ['A', 'B']);
  assert.deepEqual(resolutionEffects(presets, 'Hi'), ['C']);
});

test('an unknown preset, or one carrying no list, reports none', () => {
  assert.equal(resolutionEffects({ Lo: { favorites: ['A'] } }, 'Mid'), null);
  assert.equal(resolutionEffects({ Lo: { dotSize: 2 } }, 'Lo'), null);
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(resolutionEffects({ Lo: { favorites: ['A'] } }, name), null, name);
  }
});

// switchFailureReport turns a runSwitchTransaction outcome into console lines
// and a user-visible notice or fatal banner.

test('a successful switch reports nothing', () => {
  assert.deepEqual(
    switchFailureReport('Effect',
      { applied: true, failure: null, recoveryFailure: null }),
    { logs: [], notice: null, fatal: null });
});

test('a rejection with no thrown value reports the restored value', () => {
  assert.deepEqual(
    switchFailureReport('Effect',
      { applied: false, failure: null, recoveryFailure: null }),
    {
      logs: [],
      notice: 'Effect change was rejected. The previous value was restored.',
      fatal: null,
    });
});

test('a recovered failure is logged but is not fatal', () => {
  const failure = new Error('setEffect threw');
  const report = switchFailureReport('Effect',
    { applied: false, failure, recoveryFailure: null });

  assert.equal(report.logs.length, 1);
  assert.match(report.logs[0].message, /^Effect switch failed/);
  assert.equal(report.logs[0].error, failure);
  assert.match(report.notice, /^Effect change was rejected/);
  assert.equal(report.fatal, null);
});

test('a failed rollback logs both errors and is fatal', () => {
  const failure = new Error('setResolution threw');
  const recoveryFailure = new Error('rollback threw');
  const report = switchFailureReport('Resolution',
    { applied: false, failure, recoveryFailure });

  assert.deepEqual(report.logs.map((entry) => entry.error), [failure, recoveryFailure]);
  assert.match(report.logs[0].message, /^Resolution switch failed/);
  assert.match(report.logs[1].message, /^Resolution rollback failed/);
  assert.equal(report.notice, null);
  assert.match(report.fatal, /^Resolution change failed .*Reload the page\.$/);
});

test('a rejected switch whose rollback failed still raises the banner', () => {
  const recoveryFailure = new Error('rollback threw');
  const report = switchFailureReport('Effect',
    { applied: false, failure: null, recoveryFailure });

  assert.equal(report.logs.length, 1);
  assert.match(report.logs[0].message, /^Effect rollback failed/);
  assert.equal(report.logs[0].error, recoveryFailure);
  assert.match(report.fatal, /^Effect change failed/);
});

// createApplyPipeline is the apply path itself: the effect rebuild every switch
// runs, and the resolution change that resizes the engine, the pool, and the
// scene before re-applying the effect.

const APPLY_PRESETS = {
  Lo: { w: 96, h: 20, dotSize: 2 },
  Hi: { w: 288, h: 144, dotSize: 0.25 },
};
const APPLY_OFFERS = { Lo: ['Alpha', 'Beta'], Hi: ['Alpha', 'Gamma'] };

/**
 * Build the apply pipeline over doubles that record their order into one log.
 * @param {Object} [options] - Engine, pool, and state conditions to apply under.
 * @returns {Object} The pipeline plus its log, sinks, and observable state.
 */
function makeApp({
  effect = 'Alpha',
  resolution = 'Hi',
  offers = APPLY_OFFERS,
  rejectEffects = [],
  rejectResolutions = [],
  effectSizes = { Alpha: 12 },
  presetCounts = { Alpha: 3 },
  sizesFailure = null,
  presetCountsFailure = null,
  noEngine = false,
  segmented = false,
  refuseEffectSet = false,
  subscribeEffect = false,
} = {}) {
  const log = [];
  const errors = [];
  const warnings = [];
  const state = { effect, resolution };
  const rejectedEffects = new Set(rejectEffects);
  const rejectedResolutions = new Set(rejectResolutions);
  let muted = false;

  const appState = {
    get: (key) => state[key],
    set: (key, value) => {
      log.push(`state.set ${key}=${value}`);
      if (refuseEffectSet && key === 'effect') return;
      state[key] = value;
      // The app applies an effect change through its appState subscription,
      // which a muted write suppresses.
      if (subscribeEffect && !muted && key === 'effect') pipeline.applyEffect();
    },
  };

  const engine = {
    setEffect(name) {
      log.push(`engine.setEffect ${name}`);
      return rejectedEffects.has(name)
        ? EffectSetResult.UNKNOWN_EFFECT : EffectSetResult.INSTALLED;
    },
    strobeColumns: () => 7,
    setResolution(w, h) {
      log.push(`engine.setResolution ${w}x${h}`);
      return rejectedResolutions.has(`${w}x${h}`)
        ? ResolutionSetResult.UNSUPPORTED : ResolutionSetResult.RESIZED;
    },
    getEffectSizes() {
      log.push('engine.getEffectSizes');
      if (sizesFailure) throw sizesFailure;
      return effectSizes;
    },
    getEffectPresetCounts() {
      log.push('engine.getEffectPresetCounts');
      if (presetCountsFailure) throw presetCountsFailure;
      return presetCounts;
    },
  };

  const segments = {
    active: segmented,
    refreshPresetState: () => log.push('segments.refreshPresetState'),
    setEffect: (name) => log.push(`segments.setEffect ${name}`),
    setResolution: (w, h) => log.push(`segments.setResolution ${w}x${h}`),
  };

  const pipeline = createApplyPipeline({
    appState,
    getEngine: () => (noEngine ? null : engine),
    getModule: () => (noEngine ? null : { EffectSetResult, ResolutionSetResult }),
    invalidateEngineView: () => log.push('host.invalidateView'),
    presets: APPLY_PRESETS,
    availableEffects: (label) => offers[label],
    effectGui: {
      destroy: () => log.push('effectGui.destroy'),
      build: () => log.push('effectGui.build'),
      mount: () => log.push('effectGui.mount'),
      applyAnimationPause: () => log.push('effectGui.applyAnimationPause'),
    },
    clearEffectParamUrl: () => log.push('clearEffectParamUrl'),
    segments,
    driver: {
      setStrobeColumns: (n) => log.push(`driver.setStrobeColumns ${n}`),
      updateResolution: (w, h, dot) =>
        log.push(`driver.updateResolution ${w}x${h}@${dot}`),
      invalidate: () => log.push('driver.invalidate'),
    },
    sidebar: {
      setActive: (name) => log.push(`sidebar.setActive ${name}`),
      setEffects: (list, sizes, counts) => log.push(
        `sidebar.setEffects ${list.join(',')} sizes=${JSON.stringify(sizes)}`
        + ` presets=${JSON.stringify(counts)}`),
    },
    muteSubscription: (write) => {
      muted = true;
      try { write(); } finally { muted = false; }
    },
    logError: (...args) => errors.push(args.join(' ')),
    logWarn: (...args) => warnings.push(args.join(' ')),
  });

  return { pipeline, log, errors, warnings, state };
}

test('applying an effect points the engine at it and rebuilds the panel', () => {
  const app = makeApp();

  assert.equal(app.pipeline.applyEffect(), ApplyResult.APPLIED);

  assert.deepEqual(app.log, [
    'engine.setEffect Alpha',
    'driver.setStrobeColumns 7',
    'effectGui.destroy',
    'clearEffectParamUrl',
    'effectGui.build',
    'effectGui.mount',
    'effectGui.applyAnimationPause',
    'sidebar.setActive Alpha',
  ]);
});

test('a preserved apply keeps the effect param deep links', () => {
  const app = makeApp();

  app.pipeline.applyEffect(true);

  assert.equal(app.log.includes('clearEffectParamUrl'), false);
});

test('an engine rejection leaves the panel and the workers untouched', () => {
  const app = makeApp({ rejectEffects: ['Alpha'], segmented: true });

  assert.equal(app.pipeline.applyEffect(), ApplyResult.REJECTED);

  assert.deepEqual(app.log, ['engine.setEffect Alpha', 'driver.setStrobeColumns 7']);
  assert.match(app.errors[0], /setEffect\("Alpha"\) failed/);
});

test('a segmented pool is told which effect to render', () => {
  const app = makeApp({ segmented: true });

  app.pipeline.applyEffect();

  assert.deepEqual(app.log.slice(-3), [
    'segments.setEffect Alpha',
    'effectGui.applyAnimationPause',
    'sidebar.setActive Alpha',
  ]);
});

test('a segmented switch refreshes preset state before rebuilding the panel', () => {
  const app = makeApp({ segmented: true });

  app.pipeline.applyEffect();

  assert.deepEqual(app.log, [
    'engine.setEffect Alpha',
    'driver.setStrobeColumns 7',
    'segments.refreshPresetState',
    'effectGui.destroy',
    'clearEffectParamUrl',
    'effectGui.build',
    'effectGui.mount',
    'segments.setEffect Alpha',
    'effectGui.applyAnimationPause',
    'sidebar.setActive Alpha',
  ]);
});

test('a preserved pause is committed after the segmented effect rebuild', () => {
  const app = makeApp({ segmented: true });

  app.pipeline.applyEffect(true);

  assert.deepEqual(app.log, [
    'engine.setEffect Alpha',
    'driver.setStrobeColumns 7',
    'segments.refreshPresetState',
    'effectGui.destroy',
    'effectGui.build',
    'effectGui.mount',
    'segments.setEffect Alpha',
    'effectGui.applyAnimationPause',
    'sidebar.setActive Alpha',
  ]);
});

test('an engine that has not loaded yet still gets a sidebar and a mount point', () => {
  const app = makeApp({ noEngine: true });

  app.pipeline.applyEffect();

  assert.deepEqual(app.log, [
    'effectGui.destroy',
    'clearEffectParamUrl',
    'effectGui.mount',
    'effectGui.applyAnimationPause',
    'sidebar.setActive Alpha',
  ]);
});

test('a resolution change resizes every renderer before re-applying the effect', () => {
  const app = makeApp({ segmented: true });

  assert.equal(app.pipeline.applyResolution(), ApplyResult.APPLIED);

  assert.deepEqual(app.log, [
    'engine.setResolution 288x144',
    'host.invalidateView',
    'segments.setResolution 288x144',
    'driver.updateResolution 288x144@0.25',
    'engine.getEffectSizes',
    'engine.getEffectPresetCounts',
    'sidebar.setEffects Alpha,Gamma sizes={"Alpha":12} presets={"Alpha":3}',
    'engine.setEffect Alpha',
    'driver.setStrobeColumns 7',
    'segments.refreshPresetState',
    'effectGui.destroy',
    'clearEffectParamUrl',
    'effectGui.build',
    'effectGui.mount',
    'segments.setEffect Alpha',
    'effectGui.applyAnimationPause',
    'sidebar.setActive Alpha',
    'driver.invalidate',
  ]);
});

test('an unknown preset changes nothing', () => {
  const app = makeApp({ resolution: 'Mid' });

  assert.equal(app.pipeline.applyResolution(), ApplyResult.REJECTED);

  assert.deepEqual(app.log, []);
  assert.match(app.errors[0], /Unknown resolution preset "Mid"/);
});

/**
 * The resolution comes from a hand-editable URL param, so a preset lookup must
 * see own keys only: `Object.prototype` supplies a truthy value for every one of
 * its names, and the dimensions read off it are undefined.
 */
test('an inherited property name is not a preset', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const app = makeApp({ resolution: name });

    assert.equal(app.pipeline.applyResolution(), ApplyResult.REJECTED, name);
    assert.deepEqual(app.log, [], `"${name}" reached the engine`);
  }
});

test('an engine that cannot build the resolution leaves the scene at its old size', () => {
  const app = makeApp({ rejectResolutions: ['288x144'] });

  assert.equal(app.pipeline.applyResolution(), ApplyResult.REJECTED);

  assert.deepEqual(app.log, ['engine.setResolution 288x144']);
  assert.match(app.errors[0], /Unsupported resolution 288x144/);
});

test('a failed size query still lists the effects the resolution offers', () => {
  const app = makeApp({ sizesFailure: new Error('no sizes') });

  app.pipeline.applyResolution();

  assert.equal(app.log.includes(
    'sidebar.setEffects Alpha,Gamma sizes=null presets={"Alpha":3}'), true);
  assert.match(app.warnings[0], /getEffectSizes failed/);
});

test('a failed preset-count query still lists the effects and sizes', () => {
  const app = makeApp({ presetCountsFailure: new Error('no preset counts') });

  app.pipeline.applyResolution();

  assert.equal(app.log.includes(
    'sidebar.setEffects Alpha,Gamma sizes={"Alpha":12} presets=null'), true);
  assert.match(app.warnings[0], /getEffectPresetCounts failed/);
});

test('an off-list effect is corrected and applied exactly once', () => {
  const app = makeApp({ resolution: 'Lo', effect: 'Gamma', subscribeEffect: true });

  app.pipeline.applyResolution();

  assert.equal(app.state.effect, 'Alpha');
  assert.deepEqual(app.log.filter((entry) => entry === 'effectGui.build'),
    ['effectGui.build'], 'the correction applied the effect exactly once');
  assert.deepEqual(app.log.slice(-2), ['sidebar.setActive Alpha', 'driver.invalidate']);
});

/**
 * The correction is written muted, so a refused effect is reported through this
 * call's REJECTED return and the caller's resolution rollback recovers. An
 * un-muted write would open an effect transaction inside the resolution one,
 * whose rollback re-applies the off-list effect the new resolution does not
 * offer — a failure the outer rollback would have survived.
 */
test('a correction the engine refuses does not re-enter the subscription', () => {
  const app = makeApp({
    resolution: 'Lo', effect: 'Gamma', subscribeEffect: true, rejectEffects: ['Alpha'],
  });

  assert.equal(app.pipeline.applyResolution(), ApplyResult.REJECTED);

  assert.deepEqual(app.log.filter((entry) => entry === 'engine.setEffect Alpha'),
    ['engine.setEffect Alpha'], 'the subscription re-applied the correction');
  assert.equal(app.log.includes('driver.invalidate'), false);
});

test('a correction drops the outgoing effect param URL entries', () => {
  const app = makeApp({ resolution: 'Lo', effect: 'Gamma' });

  app.pipeline.applyResolution(true);

  assert.equal(app.state.effect, 'Alpha');
  assert.equal(app.log.includes('clearEffectParamUrl'), true);
});

test('a preserving apply that keeps the effect keeps its param URL entries', () => {
  const app = makeApp({ resolution: 'Lo', effect: 'Alpha' });

  app.pipeline.applyResolution(true);

  assert.equal(app.log.includes('clearEffectParamUrl'), false);
});

test('a refused effect correction rejects the resolution change', () => {
  const app = makeApp({ resolution: 'Lo', effect: 'Gamma', refuseEffectSet: true });

  assert.equal(app.pipeline.applyResolution(), ApplyResult.REJECTED);

  assert.equal(app.log.includes('driver.invalidate'), false);
});

test('an effect the resized engine rejects rejects the resolution change', () => {
  const app = makeApp({ rejectEffects: ['Alpha'] });

  assert.equal(app.pipeline.applyResolution(), ApplyResult.REJECTED);

  assert.equal(app.log.includes('driver.invalidate'), false);
});
