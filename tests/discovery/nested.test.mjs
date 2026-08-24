import { test } from 'node:test';
import assert from 'node:assert/strict';

test('recursive test discovery reaches nested Node modules', () => {
  assert.equal(process.release.name, 'node');
});
