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

const GENERATOR_SCENARIOS = [
  {name: 'raw', raw: true, accepted: false, identity: false},
  {name: 'companions', raw: true, accepted: true, identity: false},
  {name: 'accepted', raw: false, accepted: true, identity: false},
  {name: 'identity raw', raw: true, accepted: false, identity: true},
  {name: 'identity accepted', raw: false, accepted: true, identity: true},
];

for (const scenario of GENERATOR_SCENARIOS) {
  test(`Mobius generator URL hydration settles before canonicalization (${scenario.name})`, async () => {
    const {default: createModule} = await import('../generated/holosphere_wasm.js');
    const module = await createModule({print: () => {}});
    const engine = new module.HolosphereEngine();
    assert.notEqual(engine.setResolution(96, 20), module.ResolutionSetResult.UNSUPPORTED, '96x20');
    assert.equal(engine.setEffect('MobiusGrid'), module.EffectSetResult.INSTALLED, 'MobiusGrid');
    const target = {'Spin X': 1.25, 'Spin Y': -0.5, 'Spin Z': 0,
      'Push X': 2, 'Push Y': -0.25, 'Push Z': 0.75};
    if (scenario.identity) for (const name of Object.keys(target)) target[name] = 0;
    const url = new URL('https://example.test/?effect=MobiusGrid');
    for (const [name, value] of Object.entries(target)) {
      if (scenario.raw) url.searchParams.set(`fx.${name}`, value);
      if (scenario.accepted) url.searchParams.set(`fx.__accepted.${name}`, value);
    }
    const win = {location: url, setTimeout, clearTimeout,
      history: {replaceState(state, title, next) {win.location = new URL(next, win.location);}}};
    const sync = new URLSync(new AppState({effect: 'MobiusGrid'}), ['effect'], {}, win);
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
        .filter((parameter) => Object.hasOwn(target, parameter.name))
        .map((parameter) => [parameter.name, parameter.acceptedValue]));
      assert.deepEqual(actual, target);
      const generatorWrites = writes.filter(({name}) => Object.hasOwn(target, name));
      assert.equal(generatorWrites.length, Object.keys(target).length * (scenario.raw && scenario.accepted ? 2 : 1));
      assert.ok(generatorWrites.every(({accepted}) => accepted));
      for (const [name, value] of Object.entries(target)) {
        if (scenario.raw) assert.equal(Number(win.location.searchParams.get(`fx.${name}`)), value);
        assert.equal(Number(win.location.searchParams.get(`fx.__accepted.${name}`)), value);
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
    assert.notEqual(engine.setResolution(96, 20), module.ResolutionSetResult.UNSUPPORTED, '96x20');
    assert.equal(engine.setEffect('AlienBrain'), module.EffectSetResult.INSTALLED, 'AlienBrain');
    const panel = createEffectGui(realEngineDeps(module, engine, win, { warnings }));
    const speed = () => engine.getParameterDefinitions()
      .find((parameter) => parameter.name === 'Speed').acceptedValue;
    const reload = () => {
      panel.destroy();
      assert.equal(engine.setEffect('AlienBrain'), module.EffectSetResult.INSTALLED, 'AlienBrain');
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

test('composed engine definitions publish complete pipeline groups', async () => {
  const {default: createModule} = await import('../generated/holosphere_wasm.js');
  const {stageGrouping} = await import('../src/effects/shader_stages.js');
  const module = await createModule({print: () => {}});
  const engine = new module.HolosphereEngine();
  try {
    for (const resolution of [[96, 20], [288, 144]]) {
      assert.notEqual(engine.setResolution(...resolution), module.ResolutionSetResult.UNSUPPORTED, resolution.join('x'));
      for (const effect of ['KaleidoscopeMelt', 'KaleidoscopeSmooth', 'AshCloud', 'ChromaticLichen']) {
        assert.equal(engine.setEffect(effect), module.EffectSetResult.INSTALLED, effect);
        const parameters = engine.getParameterDefinitions();
        const assignments = stageGrouping(parameters)?.assignments;
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
    assert.notEqual(engine.setResolution(96, 20), module.ResolutionSetResult.UNSUPPORTED, '96x20');
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
