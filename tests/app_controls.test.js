// The global keydown guard and the Test All ticker.
import { fakeScheduler } from './helpers/fake_timers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './helpers/fake_dom.js';
import { createGlobalKeydownHandler, createTestAllTicker } from '../src/app/app_controls.js';

// The global keydown guard: the shortcuts are the canvas's, so a key typed into
// a control belongs to that control.

/**
 * Build the handler over a fake DOM tree and a recording dispatch sink.
 * @returns {Object} The handler, the tree's nodes, and the delivered keys.
 */
function makeKeydownHandler() {
  const keys = [];
  const handler = createGlobalKeydownHandler({ dispatch: (e) => keys.push(e.key) });

  const canvas = fakeElement('canvas');
  const textField = fakeElement('input');
  const panel = fakeElement('div');
  panel.className = 'lil-gui';
  const slider = fakeElement('div');
  panel.appendChild(slider);
  const sidebar = fakeElement('div');
  sidebar.className = 'effect-sidebar';
  const entry = fakeElement('span');
  sidebar.appendChild(entry);
  const note = fakeElement('div');
  note.setAttribute('contenteditable', '');

  return { handler, keys, canvas, textField, panel, slider, sidebar, entry, note };
}

test('a canvas hotkey reaches the simulation', () => {
  const h = makeKeydownHandler();

  h.canvas.addEventListener('keydown', h.handler);
  h.canvas.dispatch('keydown', { key: ' ' });

  assert.deepEqual(h.keys, [' '], 'nothing owns the key, so the shortcut runs');
});

test('a hotkey typed mid-text-edit never reaches the simulation', () => {
  const h = makeKeydownHandler();

  // The window listener sees the event after it bubbles, still targeting the field.
  h.handler({ key: ' ', target: h.textField });
  h.handler({ key: ' ', target: h.note });

  assert.deepEqual(h.keys, [],
    'typing a space into a field must not also toggle playback');
});

test('a hotkey inside a GUI panel or the sidebar belongs to that control', () => {
  const h = makeKeydownHandler();

  // Descendants: the guard has to walk up to the panel/sidebar, not just test
  // the target itself.
  h.handler({ key: ' ', target: h.slider });
  h.handler({ key: 'ArrowRight', target: h.entry });
  h.handler({ key: ' ', target: h.panel });
  h.handler({ key: ' ', target: h.sidebar });

  assert.deepEqual(h.keys, []);
});

test('engine statistics regions own Space and arrow keys', () => {
  const h = makeKeydownHandler();
  const desktop = fakeElement('div');
  desktop.setAttribute('id', 'global-stats-desktop');
  const mobile = fakeElement('div');
  mobile.className = 'stats-bar';
  for (const target of [desktop, mobile]) {
    for (const key of [' ', 'ArrowLeft', 'ArrowRight']) h.handler({ key, target });
  }
  assert.deepEqual(h.keys, []);
});

test('a key with no element target still reaches the simulation', () => {
  const h = makeKeydownHandler();

  h.handler({ key: 'p', target: null });
  h.handler({ key: 'p', target: globalThis });

  assert.deepEqual(h.keys, ['p', 'p'],
    'only a node in the document can own the key');
});

test('chain chip selection and roaming do not drive global playback', () => {
  let paused = false;
  const handler = createGlobalKeydownHandler({ dispatch: () => { paused = !paused; } });
  const strip = fakeElement('div');
  strip.className = 'chain-strip-region';
  const chip = fakeElement('div');
  chip.className = 'chain-chip';
  strip.appendChild(chip);

  for (const key of [' ', 'ArrowLeft', 'ArrowRight']) {
    handler({ key, target: chip });
    assert.equal(paused, false);
  }
});

// The Test All ticker walks the resolution's effect list on a timer with its own
// index: a rejected switch reverts the effect.

/**
 * Build the ticker over a fake interval timer and a recording effect switch.
 * @param {Object} [options] - Starting effect, the lists offered, engine state.
 * @returns {Object} The ticker, its doubles, and the requested effect names.
 */
function makeTicker({
  effect = 'Alpha',
  lists = [['Alpha', 'Beta', 'Gamma']],
  engineReady = true,
  acceptSwitch = true,
} = {}) {
  const requested = [];
  const state = { effect, engineReady, listIndex: 0 };
  const timer = fakeScheduler({ repeat: true });
  const ticker = createTestAllTicker({
    intervalMs: 1000,
    availableEffects: () => lists[state.listIndex],
    getEffect: () => state.effect,
    setEffect: (name) => {
      requested.push(name);
      if (acceptSwitch) state.effect = name;
    },
    engineReady: () => state.engineReady,
    schedule: timer.schedule,
    cancel: timer.cancel,
  });
  return {
    ticker,
    requested,
    state,
    timer,
    tick: (n = 1) => { for (let i = 0; i < n; i++) timer.fire(); },
  };
}

test('the ticker walks the list on from the live effect', () => {
  const h = makeTicker({ effect: 'Beta' });

  h.ticker.start();
  assert.equal(h.timer.ms, 1000, 'the dwell time is the one it was built with');
  h.tick(2);

  assert.deepEqual(h.requested, ['Gamma', 'Alpha'], 'and wraps at the end');
});

test('the walk continues past an effect the engine refused', () => {
  const h = makeTicker({ acceptSwitch: false });

  h.ticker.start();
  h.tick(2);

  assert.deepEqual(h.requested, ['Beta', 'Gamma'],
    'a reverted effect must not make the ticker retry the same slot');
});

test('a live effect the list does not offer starts the walk at its head', () => {
  const h = makeTicker({ effect: 'Zeta' });

  h.ticker.start();
  h.tick();

  assert.deepEqual(h.requested, ['Alpha']);
});

test('a tick before the engine loads switches nothing and loses no ground', () => {
  const h = makeTicker({ engineReady: false });

  h.ticker.start();
  h.tick(2);
  assert.deepEqual(h.requested, [], 'there is no engine to take the switch');

  h.state.engineReady = true;
  h.tick();
  assert.deepEqual(h.requested, ['Beta'], 'the walk resumes where it started');
});

test('a resolution change mid-walk continues through the new list', () => {
  const h = makeTicker({ lists: [['Alpha', 'Beta', 'Gamma'], ['Lo1', 'Lo2']] });

  h.ticker.start();
  h.tick();
  h.state.listIndex = 1;
  h.tick(2);

  assert.deepEqual(h.requested, ['Beta', 'Lo1', 'Lo2'],
    'the index is taken modulo the list the tick actually reads');
});

test('a resolution offering nothing ticks without a switch', () => {
  const h = makeTicker({ lists: [[]] });

  h.ticker.start();
  h.tick(2);

  assert.deepEqual(h.requested, []);
});

test('stopping cancels the interval, and starting arms exactly one', () => {
  const h = makeTicker();

  h.ticker.start();
  h.ticker.start();
  assert.equal(h.timer.handle, 1, 'a re-entered toggle must not arm a second timer');
  assert.equal(h.ticker.running(), true);

  h.ticker.stop();
  assert.deepEqual(h.timer.cancelled, [1]);
  assert.equal(h.ticker.running(), false);

  h.ticker.stop();
  assert.deepEqual(h.timer.cancelled, [1], 'stopping twice cancels once');

  h.ticker.start();
  assert.equal(h.timer.handle, 2, 'a stopped ticker starts again');
});

test('focused links and their children retain Space and arrow keys', () => {
  const h = makeKeydownHandler();
  const link = fakeElement('a');
  link.setAttribute('href', '/tools/');
  const label = fakeElement('span');
  link.appendChild(label);
  for (const target of [link, label]) {
    for (const key of [' ', 'ArrowLeft', 'ArrowRight']) h.handler({ key, target });
  }
  assert.deepEqual(h.keys, []);
});

test('form controls retain Space and arrow keys', () => {
  for (const tag of ['textarea', 'select', 'button']) {
    const h = makeKeydownHandler();
    const control = fakeElement(tag);
    for (const key of [' ', 'ArrowLeft', 'ArrowRight']) h.handler({ key, target: control });
    assert.deepEqual(h.keys, [], tag);
  }
});

test('an anchor without href does not own the key', () => {
  const h = makeKeydownHandler();
  h.handler({ key: ' ', target: fakeElement('a') });
  assert.deepEqual(h.keys, [' ']);
});
