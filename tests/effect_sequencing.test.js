// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planResolutionApply,
  paramValueSkew,
  paramGenerationStale,
  runSwitchTransaction,
  applyInitialState,
  snapshotEffectControlState,
  restoreEffectControlState,
  offeredResolutions,
  resolutionCorrection,
  resolutionEffects,
  switchFailureReport,
} from '../effect_sequencing.js';

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
    animationState,
    pauseController,
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
  effect.animationState.pause = false;

  assert.deepEqual(snapshot, {
    paramValues: [['Speed', 0.75], ['Glow', true]],
    animationsPaused: true,
  });
});

test('effect state restoration updates controls, engine, workers, and URL together', () => {
  const snapshot = snapshotEffectControlState(
    makeEffectControls({ Speed: 0.75, Glow: true }, true));
  const sinks = makeSinks();
  const rebuilt = makeEffectControls({ Speed: 0.1, Glow: false }, false, sinks);

  restoreEffectControlState(rebuilt, snapshot);

  const expected = { Speed: 0.75, Glow: true, paused: true };
  assert.deepEqual({ ...rebuilt.state, paused: rebuilt.animationState.pause }, expected);
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
    () => { events.push('apply'); },
    () => { events.push('dismiss'); },
  );

  assert.deepEqual(events, ['apply', 'dismiss']);
});

test('a rejected initial state keeps the loader visible and throws', () => {
  let dismissed = false;

  assert.throws(
    () => applyInitialState(() => false, () => { dismissed = true; }),
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
  const result = runSwitchTransaction(() => true, () => { rollbacks++; });

  assert.deepEqual(result, { applied: true, failure: null, recoveryFailure: null });
  assert.equal(rollbacks, 0);
});

test('a rejected switch restores the previous applied state', () => {
  let restored = false;
  const result = runSwitchTransaction(() => false, () => { restored = true; });

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
// else fall back to the list head, and report whether the caller must call
// applyEffect() itself — a change fires applyEffect via the appState
// subscription, unless that subscription is muted.

test('offered effect is kept and applied directly (no subscription fire)', () => {
  assert.deepEqual(
    planResolutionApply(['A', 'B', 'C'], 'B'),
    { nextEffect: 'B', effectChanged: false, applyDirectly: true });
});

test('off-list effect falls back to the first entry; the change fires applyEffect', () => {
  assert.deepEqual(
    planResolutionApply(['A', 'B', 'C'], 'Z'),
    { nextEffect: 'A', effectChanged: true, applyDirectly: false });
});

test('the first entry itself is kept and applied directly', () => {
  assert.deepEqual(
    planResolutionApply(['A', 'B', 'C'], 'A'),
    { nextEffect: 'A', effectChanged: false, applyDirectly: true });
});

test('effectChanged and applyDirectly are complements while the subscription is live', () => {
  for (const cur of ['A', 'Z', 'C']) {
    const r = planResolutionApply(['A', 'B', 'C'], cur);
    assert.equal(r.applyDirectly, !r.effectChanged);
  }
});

test('a muted subscription makes the caller apply an off-list correction', () => {
  assert.deepEqual(
    planResolutionApply(['A', 'B', 'C'], 'Z', true),
    { nextEffect: 'A', effectChanged: true, applyDirectly: true });
});

test('a muted subscription still applies directly when the effect is unchanged', () => {
  for (const cur of ['A', 'B', 'C']) {
    assert.equal(planResolutionApply(['A', 'B', 'C'], cur, true).applyDirectly, true);
  }
});

// paramValueSkew guards syncGUI()/export() from pairing a drifted param-name
// list with the engine's value stream by index.

test('equal lengths do not skew', () => {
  assert.equal(paramValueSkew(3, 3), false);
  assert.equal(paramValueSkew(0, 0), false);
});

test('unequal lengths skew (either direction)', () => {
  assert.equal(paramValueSkew(3, 4), true);
  assert.equal(paramValueSkew(4, 3), true);
  assert.equal(paramValueSkew(0, 1), true);
});

// paramGenerationStale is the identity half of the same guard: it catches an
// effect switch the length comparison cannot see.

test('a snapshot read at the engine\'s current generation is not stale', () => {
  assert.equal(paramGenerationStale(0, 0), false);
  assert.equal(paramGenerationStale(7, 7), false);
});

test('any generation move makes the snapshot stale', () => {
  assert.equal(paramGenerationStale(7, 8), true);
  assert.equal(paramGenerationStale(8, 7), true);
  assert.equal(paramGenerationStale(0, 1), true);
});

test('an engine reporting no generation is never stale', () => {
  assert.equal(paramGenerationStale(undefined, undefined), false);
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
});

// switchFailureReport turns a runSwitchTransaction outcome into console lines
// and, only when the rollback also failed, a fatal banner.

test('a successful switch reports nothing', () => {
  assert.deepEqual(
    switchFailureReport('Effect',
      { applied: true, failure: null, recoveryFailure: null }),
    { logs: [], fatal: null });
});

test('a rejection with no thrown value reports nothing', () => {
  assert.deepEqual(
    switchFailureReport('Effect',
      { applied: false, failure: null, recoveryFailure: null }),
    { logs: [], fatal: null });
});

test('a recovered failure is logged but is not fatal', () => {
  const failure = new Error('setEffect threw');
  assert.deepEqual(
    switchFailureReport('Effect',
      { applied: false, failure, recoveryFailure: null }),
    { logs: [{ message: 'Effect switch failed:', error: failure }], fatal: null });
});

test('a failed rollback logs both errors and is fatal', () => {
  const failure = new Error('setResolution threw');
  const recoveryFailure = new Error('rollback threw');
  assert.deepEqual(
    switchFailureReport('Resolution', { applied: false, failure, recoveryFailure }),
    {
      logs: [
        { message: 'Resolution switch failed:', error: failure },
        { message: 'Resolution rollback failed:', error: recoveryFailure },
      ],
      fatal: 'Resolution change failed and the previous state could not be '
        + 'restored. Reload the page.',
    });
});

test('a rejected switch whose rollback failed still raises the banner', () => {
  const recoveryFailure = new Error('rollback threw');
  const report = switchFailureReport('Effect',
    { applied: false, failure: null, recoveryFailure });

  assert.deepEqual(report.logs,
    [{ message: 'Effect rollback failed:', error: recoveryFailure }]);
  assert.match(report.fatal, /^Effect change failed/);
});
