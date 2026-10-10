import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructorToObject, glslConstants } from './helpers/source_transpile.js';

test('constructor rewriting accepts nested arguments and both constructor names', () => {
  for (const name of ['Complex', 'CNum']) {
    const js = constructorToObject(`${name}(Math.max(1, 2), ${name}(3, 4).re)`, name);
    assert.deepEqual(Function(`return ${js}`)(), { re: 2, im: 3 });
  }
});

test('constructor rewriting rejects anything but one comma and a closing parenthesis', () => {
  for (const name of ['Complex', 'CNum']) {
    for (const args of ['(1)', '(1, 2', '(1, 2, 3)']) {
      assert.throws(() => constructorToObject(name + args, name), /unreadable/);
    }
  }
});

test('constructor rewriting leaves identifiers that end in the constructor name', () => {
  for (const name of ['Complex', 'CNum']) {
    for (const prefix of ['to', '_', '$']) {
      const js = `${prefix}${name}(1, 2)`;
      assert.equal(constructorToObject(js, name), js);
    }
    assert.equal(constructorToObject(`to${name}(${name}(1, 2))`, name),
      `to${name}(({ re: (1), im: ( 2) }))`);
  }
});

test('GLSL constants evaluate derived values in declaration order', () => {
  assert.deepEqual(glslConstants('const float A = 2; const float B = A / 4;').values,
    { A: 2, B: 0.5 });
});
