//
// createSwitchCoordinator — the effect/resolution switch transaction daydream.js
// subscribes to appState. Driven here against a real AppState and fake
// apply/URL/GUI collaborators, so the rollback, mute-window, URL re-assert and
// unsubscribe rules are checked without a WASM engine, lil-gui, or a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppState } from '../state.js';
import { ApplyResult, createSwitchCoordinator } from '../effect_sequencing.js';

// An effect GUI record in the shape snapshotEffectControlState() reads: one
// writable "Speed" control plus the pause toggle.
function makeEffectRecord(name, speed, paused) {
  const state = { Speed: speed, paused };
  return {
    name,
    state,
    animationState: { pause: paused },
    pauseController: { setValue: (v) => { state.paused = v; } },
    writableParamNames: ['Speed'],
    controllerByName: new Map([['Speed', {
      getValue: () => state.Speed,
      setValue: (v) => { state.Speed = v; },
    }]]),
  };
}

/**
 * Build a coordinator over fake collaborators.
 * @param {Object} [options]
 * @param {Set<string>} [options.rejectEffects] - Effects applyEffect() rejects.
 * @param {Set<string>} [options.rejectResolutions] - Resolutions applyResolution() rejects.
 * @param {Error} [options.throwOnEffect] - Thrown by applyEffect() for any effect.
 */
function makeApp({
  rejectEffects = new Set(),
  rejectResolutions = new Set(),
  throwOnEffect = null,
} = {}) {
  const appState = new AppState({ effect: 'Alpha', resolution: 'Lo' });
  const app = {
    appState,
    // What the engine/GUI layer actually holds, as distinct from appState.
    applied: { effect: 'Alpha', resolution: 'Lo' },
    activeEffect: makeEffectRecord('Alpha', 0.5, false),
    url: '/?effect=Alpha',
    control: { resolution: 'Lo' },
    calls: [],
    errors: [],
    notices: [],
    fatals: [],
    urlSyncs: [],
  };

  const applyEffect = (preserveParams = false) => {
    const effect = appState.get('effect');
    app.calls.push({
      fn: 'applyEffect', effect, preserveParams,
      restoring: app.switches.isRestoring(),
    });
    if (throwOnEffect && !app.switches.isRestoring()) throw throwOnEffect;
    if (rejectEffects.has(effect)) return ApplyResult.REJECTED;
    app.applied.effect = effect;
    // A successful apply rebuilds the GUI: fresh record, engine-default values.
    app.activeEffect = makeEffectRecord(effect, 0, false);
    return ApplyResult.APPLIED;
  };

  const applyResolution = (preserveParams = false) => {
    const resolution = appState.get('resolution');
    app.calls.push({
      fn: 'applyResolution', resolution, preserveParams,
      restoring: app.switches.isRestoring(),
    });
    if (rejectResolutions.has(resolution)) return ApplyResult.REJECTED;
    app.applied.resolution = resolution;
    return applyEffect(preserveParams);
  };

  app.switches = createSwitchCoordinator({
    appState,
    getActiveEffect: () => app.activeEffect,
    applyEffect,
    applyResolution,
    currentUrl: () => app.url,
    restoreUrl: (url) => { app.url = url; },
    showResolution: (resolution) => { app.control.resolution = resolution; },
    syncResolutionUrl: () => app.urlSyncs.push(appState.get('resolution')),
    logError: (message, error) => app.errors.push({ message, error }),
    showNotice: (message) => app.notices.push(message),
    showFatal: (message) => app.fatals.push(message),
  });
  return app;
}

const applyCalls = (app, fn) => app.calls.filter((c) => c.fn === fn);

test('an accepted effect switch applies it and reports nothing', () => {
  const app = makeApp();

  app.appState.set('effect', 'Beta');

  assert.equal(app.applied.effect, 'Beta');
  assert.equal(app.appState.get('effect'), 'Beta');
  assert.deepEqual(applyCalls(app, 'applyEffect').map((c) => c.preserveParams), [false]);
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.notices, [null]);
  assert.deepEqual(app.fatals, []);
});

test('a rejected effect switch restores state, URL, and control values', () => {
  const app = makeApp({ rejectEffects: new Set(['Beta']) });
  app.activeEffect.state.Speed = 0.9;
  const urlBefore = app.url;

  app.appState.set('effect', 'Beta');

  assert.equal(app.appState.get('effect'), 'Alpha');
  assert.equal(app.applied.effect, 'Alpha');
  assert.equal(app.url, urlBefore);
  // The rollback rebuilt the GUI at engine defaults, then replayed the snapshot.
  assert.equal(app.activeEffect.state.Speed, 0.9);
  assert.deepEqual(app.notices,
    ['Effect change was rejected. The previous value was restored.']);
  assert.deepEqual(app.fatals, []);
});

test('a rejected effect switch re-applies with preserveParams and stays muted', () => {
  const app = makeApp({ rejectEffects: new Set(['Beta']) });

  app.appState.set('effect', 'Beta');

  const calls = applyCalls(app, 'applyEffect');
  // Exactly two: the rejected apply, then the rollback apply. A third would mean
  // the rollback's appState.set() re-entered the subscription.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    fn: 'applyEffect', effect: 'Beta', preserveParams: false, restoring: false });
  assert.deepEqual(calls[1], {
    fn: 'applyEffect', effect: 'Alpha', preserveParams: true, restoring: true });
  assert.equal(app.switches.isRestoring(), false);
});

test('a rejected switch alone is shown but not fatal', () => {
  const app = makeApp({ rejectEffects: new Set(['Beta']) });

  app.appState.set('effect', 'Beta');

  // A rejection carries no thrown value, so there is nothing to log either.
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.fatals, []);
});

test('a thrown effect apply is logged and rolled back', () => {
  const failure = new Error('setEffect exploded');
  const app = makeApp({ throwOnEffect: failure });

  app.appState.set('effect', 'Beta');

  assert.equal(app.appState.get('effect'), 'Alpha');
  assert.deepEqual(app.errors, [{ message: 'Effect switch failed:', error: failure }]);
  assert.deepEqual(app.fatals, []);
});

test('an effect rollback that is itself rejected raises the fatal banner', () => {
  const app = makeApp({ rejectEffects: new Set(['Alpha', 'Beta']) });

  app.appState.set('effect', 'Beta');

  assert.equal(app.errors.length, 1);
  assert.equal(app.errors[0].message, 'Effect rollback failed:');
  assert.match(app.errors[0].error.message, /Effect rollback to "Alpha" was rejected/);
  assert.deepEqual(app.fatals, [
    'Effect change failed and the previous state could not be restored. Reload the page.',
  ]);
  // The mute window closes even when the rollback throws.
  assert.equal(app.switches.isRestoring(), false);
});

test('an accepted resolution switch applies it without re-asserting the URL',
  async () => {
    const app = makeApp();

    app.appState.set('resolution', 'Hi');
    await Promise.resolve();

    assert.equal(app.applied.resolution, 'Hi');
    assert.deepEqual(app.urlSyncs, []);
    assert.deepEqual(app.errors, []);
  });

test('a rejected resolution switch restores resolution, effect, URL, and control',
  async () => {
    const app = makeApp({ rejectResolutions: new Set(['Hi']) });
    app.appState.set('effect', 'Beta');
    app.url = '/?effect=Beta';
    app.activeEffect.state.Speed = 0.75;
    app.control.resolution = 'Hi';

    app.appState.set('resolution', 'Hi');
    await Promise.resolve();

    assert.equal(app.appState.get('resolution'), 'Lo');
    assert.equal(app.applied.resolution, 'Lo');
    assert.equal(app.appState.get('effect'), 'Beta');
    assert.equal(app.url, '/?effect=Beta');
    // The dropdown must not keep advertising the resolution that was refused.
    assert.equal(app.control.resolution, 'Lo');
    assert.equal(app.activeEffect.state.Speed, 0.75);
    assert.deepEqual(app.fatals, []);
  });

test('a rejected resolution switch re-asserts the applied resolution in the URL',
  async () => {
    const app = makeApp({ rejectResolutions: new Set(['Hi']) });

    app.appState.set('resolution', 'Hi');
    // Deferred past the current task, after the rollback settles state.
    assert.deepEqual(app.urlSyncs, []);
    await Promise.resolve();

    assert.deepEqual(app.urlSyncs, ['Lo']);
  });

test('a resolution rollback re-applies with preserveParams and stays muted',
  async () => {
    const app = makeApp({ rejectResolutions: new Set(['Hi']) });

    app.appState.set('resolution', 'Hi');
    await Promise.resolve();

    const calls = applyCalls(app, 'applyResolution');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      fn: 'applyResolution', resolution: 'Hi', preserveParams: false, restoring: false });
    assert.deepEqual(calls[1], {
      fn: 'applyResolution', resolution: 'Lo', preserveParams: true, restoring: true });
    assert.equal(app.switches.isRestoring(), false);
  });

test('a resolution rollback that is itself rejected raises the fatal banner',
  async () => {
    const app = makeApp({ rejectResolutions: new Set(['Lo', 'Hi']) });

    app.appState.set('resolution', 'Hi');
    await Promise.resolve();

    assert.equal(app.errors.length, 1);
    assert.equal(app.errors[0].message, 'Resolution rollback failed:');
    assert.match(app.errors[0].error.message, /Resolution rollback to "Lo" was rejected/);
    assert.deepEqual(app.fatals, [
      'Resolution change failed and the previous state could not be restored. '
        + 'Reload the page.',
    ]);
    assert.deepEqual(app.urlSyncs, ['Lo']);
  });

test('a resolution rollback restores the effect the pre-switch resolution offered',
  async () => {
    const app = makeApp({ rejectResolutions: new Set(['Hi']) });
    app.appState.set('effect', 'Beta');

    app.appState.set('resolution', 'Hi');
    await Promise.resolve();

    // update() writes both keys before notifying, so the rollback's effect and
    // resolution are never observed apart.
    assert.deepEqual(
      { effect: app.appState.get('effect'), resolution: app.appState.get('resolution') },
      { effect: 'Beta', resolution: 'Lo' });
    assert.equal(app.applied.effect, 'Beta');
  });

test('keys other than effect and resolution are ignored', () => {
  const app = makeApp();

  app.appState.set('quality', 'high');

  assert.deepEqual(app.calls, []);
});

test('dispose() stops applying later state changes', () => {
  const app = makeApp();

  app.switches.dispose();
  app.appState.set('effect', 'Beta');
  app.appState.set('resolution', 'Hi');

  assert.deepEqual(app.calls, []);
  assert.equal(app.applied.effect, 'Alpha');
  assert.equal(app.applied.resolution, 'Lo');
});

test('dispose() is idempotent and does not drop a second coordinator', () => {
  const app = makeApp();
  const other = createSwitchCoordinator({
    appState: app.appState,
    getActiveEffect: () => null,
    applyEffect: () => { app.calls.push({ fn: 'other' }); return ApplyResult.APPLIED; },
    applyResolution: () => ApplyResult.APPLIED,
    currentUrl: () => '',
    restoreUrl: () => {},
    showResolution: () => {},
    syncResolutionUrl: () => {},
    logError: () => {},
    showNotice: () => {},
    showFatal: () => {},
  });

  app.switches.dispose();
  app.switches.dispose();
  app.appState.set('effect', 'Beta');

  assert.deepEqual(app.calls.map((c) => c.fn), ['other']);
  other.dispose();
});
