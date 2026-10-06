import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructorToObject, glslConstants } from './helpers/source_transpile.js';

test('constructor rewriting accepts nested arguments and both constructor names', () => {
  for (const name of ['Complex', 'CNum']) {
    const js = constructorToObject(`${name}(Math.max(1, 2), ${name}(3, 4).re)`, name);
    assert.deepEqual(Function(`return ${js}`)(), { re: 2, im: 3 });
  }
});

test('constructor rewriting rejects missing commas and closing parentheses', () => {
  for (const name of ['Complex', 'CNum']) {
    for (const args of ['(1)', '(1, 2']) {
      assert.throws(() => constructorToObject(name + args, name), /unreadable/);
    }
  }
});

test('GLSL constants evaluate derived values in declaration order', () => {
  assert.deepEqual(glslConstants('const float A = 2; const float B = A / 4;').values,
    { A: 2, B: 0.5 });
});
