import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkCdnIntegrity } from '../scripts/check-cdn-integrity.mjs';

const bytes = 'export const x = 1;';
const hash = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
const source = `document.head.appendChild({textContent: JSON.stringify({
  integrity: {'https://cdn.jsdelivr.net/npm/test@1.0.0/index.js': '${hash}'}
})});`;

test('CDN bytes must match the committed integrity value', async () => {
  assert.equal(await checkCdnIntegrity(source, async () => new Response(bytes)), 1);
  await assert.rejects(checkCdnIntegrity(source, async () => new Response(`${bytes}\n`)),
    /integrity mismatch/);
  await assert.rejects(checkCdnIntegrity(source, async () => new Response('', { status: 404 })),
    /HTTP 404/);
  await assert.rejects(checkCdnIntegrity('document.head.appendChild({textContent: "{}"})'),
    /empty/);
});
