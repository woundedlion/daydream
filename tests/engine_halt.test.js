// The halted-engine predicate the tool pages gate every later bridge call on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineHalted, standDownIfHalted } from '../tools/engine_halt.js';

test('the caller that was on the stack sees the trap as a RuntimeError', () => {
  assert.equal(engineHalted(new WebAssembly.RuntimeError('unreachable')), true);
  assert.equal(engineHalted(new WebAssembly.RuntimeError('unreachable'), {}), true);
});

test('a module that trapped elsewhere is halted whatever the error was', () => {
  const dead = { HS_MODULE_DEAD: true };
  assert.equal(engineHalted(new TypeError('not a function'), dead), true);
  assert.equal(engineHalted(null, dead), true);
});

test('an ordinary rejection off a live module is not a halt', () => {
  assert.equal(engineHalted(new Error('op rejected'), {}), false);
  assert.equal(engineHalted(new Error('op rejected'), { HS_MODULE_DEAD: false }), false);
  assert.equal(engineHalted(new Error('op rejected')), false);
  assert.equal(engineHalted(new Error('op rejected'), null), false);
});

test('a live module is left standing', () => {
  let seen = null;
  assert.equal(
    standDownIfHalted(new Error('op rejected'), {}, (m) => { seen = m; }), false);
  assert.equal(seen, null);
});

test('a halt stands the page down with the shared notice', () => {
  let seen = null;
  assert.equal(standDownIfHalted(
    new WebAssembly.RuntimeError('unreachable'), {}, (m) => { seen = m; }), true);
  assert.match(seen, /^The WASM engine hit an internal invariant and is halted/);
  assert.doesNotMatch(seen, /slipped past validation/);
});

test('a page detail is appended after the shared notice', () => {
  let seen = null;
  standDownIfHalted(null, { HS_MODULE_DEAD: true }, (m) => { seen = m; },
    '(The op that caused this slipped past validation; please report the chain.)');
  assert.match(seen, /halted — reload the page\. \(The op that caused this/);
});
