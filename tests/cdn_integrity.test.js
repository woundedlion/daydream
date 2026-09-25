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
  let attempts = 0;
  const waits = [];
  await assert.rejects(checkCdnIntegrity(source, async () => {
    attempts++;
    return new Response('', { status: 404 });
  }, async (ms) => { waits.push(ms); }), /HTTP 404/);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 500]);
  await assert.rejects(checkCdnIntegrity('document.head.appendChild({textContent: "{}"})'),
    /empty/);
});

test('transient requests retry with bounded backoff and mismatches do not retry', async () => {
  let attempts = 0;
  const waits = [];
  assert.equal(await checkCdnIntegrity(source, async () => {
    attempts++;
    if (attempts === 1) throw new Error('DNS unavailable');
    return new Response(bytes, { status: attempts === 2 ? 503 : 200 });
  }, async (ms) => { waits.push(ms); }), 1);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 500]);
  attempts = 0;
  await assert.rejects(checkCdnIntegrity(source, async () => {
    attempts++;
    return new Response('wrong');
  }), /integrity mismatch/);
  assert.equal(attempts, 1);
});
