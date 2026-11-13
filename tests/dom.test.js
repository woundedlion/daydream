import {test} from 'node:test';
import assert from 'node:assert/strict';
import {byId} from '../src/shared/dom.js';

test('byId checks the element constructor before returning a control', () => {
  class Input {}
  class Select {}
  const input = new Input();
  const doc = {getElementById: (id) => id === 'value' ? input : null};
  assert.equal(byId('value', Input, doc), input);
  assert.throws(() => byId('value', Select, doc), /Expected Select at #value/);
  assert.throws(() => byId('missing', Input, doc), /Expected Input at #missing/);
});
