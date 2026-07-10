// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planResolutionApply, paramValueSkew } from '../effect_sequencing.js';

// planResolutionApply is the DOM/engine-free core of applyResolution()'s
// re-apply decision: keep the requested effect when the resolution offers it,
// else fall back to the list head, and report whether the caller must call
// applyEffect() itself (only when the effect did not change, since a change
// fires applyEffect via the appState subscription).

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

test('effectChanged and applyDirectly are always complements', () => {
  for (const cur of ['A', 'Z', 'C']) {
    const r = planResolutionApply(['A', 'B', 'C'], cur);
    assert.equal(r.applyDirectly, !r.effectChanged);
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
