import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleCase } from '../src/shared/labels.js';

test('shared labels preserve empty segments and single-letter words', () => {
  assert.equal(titleCase(''), '');
  assert.equal(titleCase('x-offset'), 'X Offset');
  assert.equal(titleCase('edge--fade'), 'Edge  Fade');
});
