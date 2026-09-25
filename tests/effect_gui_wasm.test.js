import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEffectGui } from '../effect_gui.js';
import { GUI } from '../gui.js';
import { AppState, URLSync } from '../state.js';
import { fakeGui } from './helpers/fake_app.js';
import { fakeElement } from './helpers/fake_dom.js';

function widgets() {
  const root = fakeGui('widgets');
  root.$children = root.domElement;
  return root;
}

test('preset values survive URL reload after flushed or pending parameter edits', async () => {
  const { default: createModule } = await import('../holosphere_wasm.js');
  const module = await createModule({ print: () => {} });
  for (const flushEdit of [false, true]) {
    const win = {
      location: new URL('https://example.test/?effect=AlienBrain'),
      setTimeout,
      clearTimeout,
      history: {
        replaceState(_state, _title, url) { win.location = new URL(url, win.location); },
      },
    };
    const sync = new URLSync(new AppState({ effect: 'AlienBrain' }), ['effect'], {}, win);
    const engine = new module.HolosphereEngine();
    engine.setResolution(96, 20);
    engine.setEffect('AlienBrain');
    const panel = createEffectGui({
      engine: {
        getParameterDefinitions: () => engine.getParameterDefinitions(),
        paramGeneration: () => engine.getParamGeneration(),
        paramValues: () => engine.getParamValues(),
        setParam: (name, value) => engine.setParameter(name, value) === module.ParamSetResult.APPLIED,
        setAnimationsPaused: (value) => engine.setAnimationsPaused(value),
        animationsPaused: () => engine.getAnimationsPaused(),
        getPresetCount: () => engine.getPresetCount(),
        getPresetIndex: () => engine.getPresetIndex(),
        synchronizePreset: (index) => engine.synchronizePreset(index),
        selectPreset: (index) => engine.selectPreset(index),
      },
      segments: { ownsDisplay: () => false, paramValues: () => null, setParam: () => {} },
      host: {
        createGui: () => new GUI(widgets(), 'fx', null, win),
        container: () => null,
        isMobile: () => false,
        applyEffect: () => {},
        dragTarget: fakeElement('window'),
      },
    });
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
      panel.active().preset.controller.setValue(1);
      const presetSpeed = speed();
      assert.notEqual(presetSpeed, edited);
      sync.flush();
      reload();
      assert.equal(speed(), presetSpeed);

      panel.active().controllerByName.get('Speed').setValue(0.02);
      const editedSpeed = speed();
      sync.flush();
      reload();
      assert.equal(speed(), editedSpeed);
    } finally {
      panel.destroy();
      sync.dispose();
      engine.delete();
    }
  }
});
