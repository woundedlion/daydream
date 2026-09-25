import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the composition root rejects a stale segmented-controller module', async (t) => {
  const actual = await import('../segment_controller.js');
  t.mock.module('../segment_controller.js', {
    namedExports: { ...actual, SEGMENT_CONTROLLER_API_VERSION: -1 },
  });
  await assert.rejects(import('../daydream.js'), { name: 'StaleModuleError' });
});
