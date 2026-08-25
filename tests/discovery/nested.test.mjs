import { test } from 'node:test';
import assert from 'node:assert/strict';

// scripts/require-tests.mjs checks statically that the configured globs reach a
// nested file. This canary is the live half: it runs only if the runner walked
// into tests/discovery/, and it names the location it was reached at, so a copy
// that drifted up out of the nested directory stops passing for the wrong
// reason.
test('recursive test discovery reaches nested Node modules', () => {
  assert.match(import.meta.url, /\/tests\/discovery\/nested\.test\.mjs$/, import.meta.url);
});
