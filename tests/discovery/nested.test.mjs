import { test } from 'node:test';
import assert from 'node:assert/strict';

// Live canary for nested test discovery: runs only if the runner walked into
// tests/discovery/, and asserts the location it was reached at.
test('recursive test discovery reaches nested Node modules', () => {
  assert.match(import.meta.url, /\/tests\/discovery\/nested\.test\.mjs$/, import.meta.url);
});
