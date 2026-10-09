import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEffectGui } from '../src/ui/effect_gui.js';
import { GUI } from '../src/ui/gui.js';
import { AppState, URLSync, roundUrlNumber } from '../src/app/state.js';
import { fakeGui } from './helpers/fake_app.js';
import { fakeElement } from './helpers/fake_dom.js';

function realEngineDeps(module, engine, win, { onWrite = () => {}, warnings }) {
  return {
    engine: {
      getParameterDefinitions: () => engine.getParameterDefinitions(),
      paramGeneration: () => engine.getParamGeneration(),
      paramValues: () => engine.getParamValues(),
      setParam: (name, value) => {
        const accepted = engine.setParameter(name, value) === module.ParamSetResult.APPLIED;
        onWrite({ name, value, accepted });
        return accepted;
      },
      setAnimationsPaused: (value) => engine.setAnimationsPaused(value),
      animationsPaused: () => engine.getAnimationsPaused(),
      getPresetCount: () => engine.getPresetCount(),
      getPresetIndex: () => engine.getPresetIndex(),
      synchronizePreset: (index) => engine.getPresetIndex() === index || engine.synchronizePreset(index),
      selectPreset: (index) => engine.selectPreset(index),
    },
    segments: { ownsDisplay: () => false, paramValues: () => null, setParam: () => {} },
    host: {
      logWarn: (...args) => warnings.push(args),
      createGui: () => new GUI(fakeGui('widgets'), 'fx', null, win),
      container: () => fakeElement('div'), isMobile: () => false,
      applyEffect: () => {}, dragTarget: fakeElement('window'),
    },
  };
}

for (const scenario of ['raw', 'companions', 'singular']) {
  test(`coupled Mobius URL hydration settles before canonicalization (${scenario})`, async () => {
    const { default: createModule } = await import('../generated/holosphere_wasm.js');
    const module = await createModule({ print: () => {} });
    const engine = new module.HolosphereEngine();
    engine.setResolution(96, 20);
    engine.setEffect('MobiusGrid');
    const target = {
      'Mobius A Re': 0, 'Mobius A Im': 0,
      'Mobius B Re': scenario === 'singular' ? 0 : 1, 'Mobius B Im': 0,
      'Mobius C Re': scenario === 'singular' ? 0 : -1, 'Mobius C Im': 0,
      'Mobius D Re': 0, 'Mobius D Im': 0,
    };
    const url = new URL('https://example.test/?effect=MobiusGrid');
    for (const [name, value] of Object.entries(target)) url.searchParams.set(`fx.${name}`, value);
    if (scenario === 'companions') {
      for (const [name, value] of Object.entries(target)) url.searchParams.set(`fx.__accepted.${name}`, value);
    }
    const win = {
      location: url, setTimeout, clearTimeout,
      history: { replaceState(state, title, next) { win.location = new URL(next, win.location); } },
    };
    const sync = new URLSync(new AppState({ effect: 'MobiusGrid' }), ['effect'], {}, win);
    const writes = [];
    const warnings = [];
    const panel = createEffectGui(realEngineDeps(module, engine, win, {
      onWrite: (write) => writes.push(write), warnings,
    }));
    try {
      panel.build();
      panel.mount();
      sync.flush();
      assert.deepEqual(warnings, []);
      const actual = Object.fromEntries(engine.getParameterDefinitions()
        .filter(p => Object.hasOwn(target, p.name)).map(p => [p.name, p.acceptedValue]));
      if (scenario !== 'singular') {
        assert.deepEqual(actual, target);
        assert.equal(win.location.searchParams.get('fx.Mobius A Im'), '0');
        assert.equal(win.location.searchParams.get('fx.__accepted.Mobius A Im'), '0');
        if (scenario === 'raw') {
          assert.deepEqual(writes.filter(w => w.name === 'Mobius A Im').map(w => w.accepted), [false, true]);
        }
      } else {
        assert.notDeepEqual(actual, target);
        assert.ok(writes.some(w => !w.accepted));
        assert.ok(writes.length <= Object.keys(target).length ** 2);
        for (const [name, value] of Object.entries(actual)) {
          assert.ok(Math.abs(Number(win.location.searchParams.get(`fx.${name}`)) - value) < 0.00001);
        }
      }
    } finally {
      panel.destroy();
      sync.dispose();
      engine.delete();
    }
  });
}

test('preset values survive URL reload after flushed or pending parameter edits', async () => {
  const { default: createModule } = await import('../generated/holosphere_wasm.js');
  const module = await createModule({ print: () => {} });
  const warnings = [];
  for (const flushEdit of [false, true]) {
    const win = {
      location: new URL('https://example.test/?effect=AlienBrain'),
      setTimeout,
      clearTimeout,
      history: {
        replaceState(state, title, url) { win.location = new URL(url, win.location); },
      },
    };
    const sync = new URLSync(new AppState({ effect: 'AlienBrain' }), ['effect'], {}, win);
    const engine = new module.HolosphereEngine();
    engine.setResolution(96, 20);
    engine.setEffect('AlienBrain');
    const panel = createEffectGui(realEngineDeps(module, engine, win, { warnings }));
    const speed = () => engine.getParameterDefinitions()
      .find((parameter) => parameter.name === 'Speed').acceptedValue;
    const reload = () => {
      panel.destroy();
      engine.setEffect('AlienBrain');
      panel.build();
      panel.applyAnimationPause();
    };
    try {
      panel.build();
      panel.applyAnimationPause();
      panel.active().controllerByName.get('Speed').setValue(0.01);
      const edited = speed();
      if (flushEdit) sync.flush();
      new Map(panel.active().actions.focusTargets()).get('presetIndex').setValue(1);
      const presetSpeed = speed();
      assert.notEqual(presetSpeed, edited);
      sync.flush();
      reload();
      assert.equal(speed(), presetSpeed);

      panel.active().controllerByName.get('Speed').setValue(0.02);
      const editedSpeed = speed();
      assert.notEqual(editedSpeed, presetSpeed);
      sync.flush();
      reload();
      assert.equal(speed(), editedSpeed);
    } finally {
      panel.destroy();
      sync.dispose();
      engine.delete();
    }
    assert.deepEqual(warnings, []);
  }
});

test('authored stage rosters recognize the engine parameter definitions', async () => {
  const {default: createModule} = await import('../generated/holosphere_wasm.js');
  const {latticeMeltStageAssignments, kaleidoscopeSmoothStageAssignments} = await import('../src/effects/shader_stages.js');
  const module = await createModule({print: () => {}});
  const engine = new module.HolosphereEngine();
  try {
    for (const resolution of [[96, 20], [288, 144]]) {
      engine.setResolution(...resolution);
      for (const [effect, recognize] of [['LatticeMelt', latticeMeltStageAssignments], ['KaleidoscopeSmooth', kaleidoscopeSmoothStageAssignments]]) {
        engine.setEffect(effect);
        const parameters = engine.getParameterDefinitions();
        const assignments = recognize(parameters);
        assert.ok(assignments, effect);
        assert.equal(assignments.size, parameters.length);
        if (effect === 'KaleidoscopeSmooth')
          assert.equal(assignments.get('Mirror Rotation'), 'Planar Warp 2');
      }
    }
  } finally { engine.delete(); }
});

test('URL numbers resolve every implicit slider step in live effect ranges', async () => {
  const { default: createModule } = await import('../generated/holosphere_wasm.js');
  const module = await createModule({ print: () => {} });
  const engine = new module.HolosphereEngine();
  let checked = 0;
  try {
    engine.setResolution(96, 20);
    for (const effect of Object.keys(engine.getEffectSizes())) {
      assert.equal(engine.setEffect(effect), module.EffectSetResult.INSTALLED, effect);
      for (const param of engine.getParameterDefinitions()) {
        if (param.readonly || typeof param.value !== 'number' || param.step === 1 || param.options || !(param.max > param.min)) continue;
        const step = (param.max - param.min) / 1000;
        const seen = new Set(Array.from({ length: 1001 }, (_, k) =>
          String(roundUrlNumber(param.min + k * step))));
        assert.equal(seen.size, 1001, `${effect}.${param.name} loses URL slider steps`);
        checked++;
      }
    }
    assert.ok(checked > 0, 'no float slider ranges checked');
  } finally {
    engine.delete();
  }
});
