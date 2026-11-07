import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageHandlers} from './helpers/page_handlers.js';

const handler = pageHandlers(new URL('../src/workbench/lissajous/lissajous_page.js', import.meta.url));

for (const activeId of ['C1', 'C2']) {
  test(`snapping ${activeId} displays the exported frequency beyond the slider grid`, () => {
    const state = {C1: 1, C2: 2, Duration: 1, isRationalLocked: true};
    const control = () => ({value: 0, readout: 0,
      setValue(value) { this.value = Math.round(value * 10) / 10; this.readout = this.value; },
      setReadout(value) { this.readout = value; }});
    const sliderHandles = {C1: control(), C2: control(), Duration: control()};
    const snapped = 1 / 3;
    const period = 6 * Math.PI;
    let scheduled = 0;
    handler('snapFrequencies', {state, sliderHandles,
      config: {[activeId]: {scale: 1000, min: 0.1, max: 10}}, MAX_RATIONAL_TERM: 12,
      snapToRationalRatio(raw, passive, max, bounds, direction) {
        assert.equal(raw, 0.375);
        assert.equal(passive, activeId === 'C1' ? 2 : 1);
        assert.equal(max, 12);
        assert.equal(bounds.min, 0.1);
        assert.equal(bounds.max, 10);
        assert.equal(direction, 0);
        return {snappedActiveC: snapped, closingPeriod: period};
      }, scheduleUpdate: () => { scheduled++; },
    })(activeId, 375);
    assert.equal(state[activeId], snapped);
    assert.equal(sliderHandles[activeId].value, 0.3);
    assert.equal(sliderHandles[activeId].readout, snapped);
    assert.equal(state.Duration, period);
    assert.equal(sliderHandles.Duration.readout, period);
    assert.equal(scheduled, 1);
  });
}

for (const [key, direction] of [['ArrowLeft', -1], ['ArrowDown', -1], ['ArrowRight', 1], ['ArrowUp', 1]]) {
  test(`locked frequency ${key} forwards the current raw value and direction`, () => {
    const writes = [];
    let prevented = false;
    handler('onKeyDown', {state: {isRationalLocked: true, C1: 1.25}, id: 'C1', scale: 100,
      snapFrequencies: (...args) => writes.push(args),
    })({key, preventDefault: () => { prevented = true; }});
    assert.deepEqual(writes, [['C1', 125, direction]]);
    assert.equal(prevented, true);
  });
}

for (const [locked, key] of [[false, 'ArrowRight'], [true, 'Enter']]) {
  test(`frequency key ${key} is unhandled when locked=${locked}`, () => {
    handler('onKeyDown', {state: {isRationalLocked: locked},
      snapFrequencies: () => assert.fail('unexpected snap'),
    })({key, preventDefault: () => assert.fail('unexpected key claim')});
  });
}
