import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CHAIN_STUDY, displayedParameter, editorWorkbench, stageEditor} from '../helpers/shader_document_harness.js';
import {ParamSetResult} from '../helpers/fake_engine.js';
import {decodeShaderStateHash} from '../../src/workbench/shader/shader_deeplink.js';

const byLabel = (root, tag, label) =>
  root.querySelectorAll(tag).find((element) => element.getAttribute('aria-label') === label);
const click = (root, label) => byLabel(root, 'button', label).dispatch('click');
const tiles = (rail) => rail.querySelectorAll('.shader-preset-tile');
const selected = (rail) => tiles(rail).find((tile) => tile.children[0].getAttribute('aria-pressed') === 'true');
const numericInput = (element, value) => {
  element.value = String(value);
  element.valueAsNumber = value;
  element.checkValidity = () => Number.isInteger(value) && value >= 1;
  element.dispatch('change');
};

async function linkState(harness) {
  await harness.controller.flushDeepLink();
  return structuredClone(await decodeShaderStateHash(harness.win.location.hash));
}

test('the preset rail edits dwell, names, edge settings and order in the linked show', async () => {
  const harness = await editorWorkbench({source: null, withPresetRail: true});
  const rail = harness.elements.get('shader-preset-rail');
  assert.equal(tiles(rail).length, 1);
  assert.equal(byLabel(rail, 'button', 'Next').disabled, true);
  const first = selected(rail).dataset.preset;

  click(rail, 'Add preset');
  const second = selected(rail).dataset.preset;
  assert.notEqual(second, first);
  assert.deepEqual(rail.querySelectorAll('.shader-preset-edge').map((edge) =>
    [edge.dataset.from, edge.dataset.to]), [[first, second], [second, first]]);
  const rename = byLabel(selected(rail), 'input', 'Preset name');
  rename.value = 'Night study';
  rename.dispatch('change');
  assert.equal(selected(rail).children[0].textContent, 'Night study');

  click(rail, 'Same dwell in every preset');
  numericInput(byLabel(rail, 'input', 'Dwell frames'), 720);
  let {document} = await linkState(harness);
  assert.deepEqual(document.preset_bank.choreography.dwell, {[first]: 600, [second]: 720});
  click(rail, 'Same dwell in every preset');
  ({document} = await linkState(harness));
  assert.deepEqual(document.preset_bank.choreography.dwell, {[first]: 720, [second]: 720});

  const outgoing = () => rail.querySelectorAll('.shader-preset-edge').find((edge) => edge.dataset.from === second);
  numericInput(byLabel(outgoing(), 'input', 'Transition duration frames'), 45);
  const easing = byLabel(outgoing(), 'select', 'Easing');
  easing.value = 'LINEAR';
  easing.dispatch('change');
  ({document} = await linkState(harness));
  assert.deepEqual(document.preset_bank.edges.find((edge) => edge.from === second),
    {from: second, to: first, duration: 45, easing: 'LINEAR', path_policy: 'parallel'});

  const origin = selected(rail);
  const target = tiles(rail)[0];
  origin.dispatch('dragstart');
  assert.equal(target.dispatch('dragover').defaultPrevented, true);
  target.dispatch('drop');
  assert.deepEqual(tiles(rail).map((tile) => tile.dataset.preset), [second, first]);

  click(selected(rail), 'Delete');
  assert.equal(tiles(rail).length, 1);
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(tiles(rail).map((tile) => tile.dataset.preset), [second, first]);
  ({document} = await linkState(harness));
  assert.deepEqual(document.preset_bank.edges.find((edge) => edge.from === second),
    {from: second, to: first, duration: 45, easing: 'LINEAR', path_policy: 'parallel'});
});

test('the rail writes live preview frames and editing a slider snaps to its active preset', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  const [from, to] = document.preset_bank.choreography.generated_order;
  document.preset_bank.edges = [[from, to], [to, from]].map(([from, to]) => ({
    from, to, duration: 4, easing: 'LINEAR', path_policy: 'parallel',
  }));
  document.preset_bank.presets.find((preset) => preset.preset_id === from).values['camera.wander'] = 0;
  document.preset_bank.presets.find((preset) => preset.preset_id === to).values['camera.wander'] = 0.5;

  const frames = [];
  const morphs = [];
  const harness = await editorWorkbench({source: JSON.stringify(document), withPresetRail: true,
    async importCompiler() {
      const compiler = await import('../../generated/shader/shader_workbench.mjs');
      return {...compiler, evaluateTransition(...args) {
        const frame = compiler.evaluateTransition(...args);
        return {...frame, sourceMorph: {instance: 'sample', evaluation: frame.evaluation, duration: frame.duration,
          easing: 'LINEAR', from: {'sample.pattern-freq': 1}, to: {'sample.pattern-freq': 2}}};
      }};
    },
    prepare(engine) {
      const getBindings = engine.getShaderChainBindings.bind(engine);
      engine.getShaderChainBindings = () => {
        const binding = getBindings();
        if (binding) {
          binding.setShaderChainSourceMorphParameters = (writes, morph) => {
            frames.push(writes.find(({name}) => name === 'camera.wander').value);
            morphs.push(morph);
            return ParamSetResult.APPLIED;
          };
        }
        return binding;
      };
    }});
  const rail = harness.elements.get('shader-preset-rail');
  const progress = () => rail.querySelector('output').textContent;
  click(rail, 'Next');
  harness.controller.stepPreview();
  assert.deepEqual(frames, [0.125]);
  assert.deepEqual(morphs, [{instance: 'sample', evaluation: 1, duration: 4, easing: 'LINEAR',
    from: {'sample.pattern-freq': 1}, to: {'sample.pattern-freq': 2}}]);
  assert.equal(progress(), '25%');
  assert.equal(Number(displayedParameter(harness, 'camera', 'camera.wander')), 0.125);
  assert.equal(harness.animationsPaused(), false);
  assert.equal(selected(rail).dataset.preset, from);

  const scrubber = byLabel(rail, 'input', 'Transition frame');
  scrubber.valueAsNumber = 3;
  scrubber.dispatch('input');
  harness.controller.stepPreview();
  harness.controller.stepPreview();
  assert.deepEqual(frames, [0.125, 0.375]);
  assert.deepEqual(morphs[1], {...morphs[0], evaluation: 3, snap: true});
  assert.equal(progress(), '75%');

  stageEditor(harness, 'camera')('camera.wander', 0.625);
  assert.equal(progress(), '0%');
  assert.equal(byLabel(rail, 'button', 'Stop').disabled, true);
  const {document: edited, preset} = await linkState(harness);
  assert.equal(preset, from);
  assert.deepEqual(edited.preset_bank.presets.map(({values}) => values['camera.wander']), [0.625, 0.5]);
});
