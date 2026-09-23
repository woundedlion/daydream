import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const EMPTY_WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

test('default warm uses its served module URL, global fetch, and clears its deadline', async (t) => {
  const moduleUrl = 'https://daydream.test/nested/module_warmer.js';
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url === moduleUrl) return {
        format: 'module', shortCircuit: true,
        source: readFileSync(new URL('../module_warmer.js', import.meta.url), 'utf8'),
      };
      return nextLoad(url, context);
    },
  });
  const requested = [];
  const timers = new Map();
  const cleared = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(url.href);
    const bytes = url.pathname.endsWith('.wasm') ? EMPTY_WASM
      : new TextEncoder().encode('new URL("holosphere_wasm.wasm?v=abc123", import.meta.url)');
    return { ok: true, arrayBuffer: async () => bytes.buffer };
  });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const token = { delay };
    timers.set(token, callback);
    return token;
  });
  t.mock.method(globalThis, 'clearTimeout', (token) => {
    cleared.push(token);
    timers.delete(token);
  });
  try {
    const { ModuleWarmer, WARM_DEADLINE_MS } = await import(moduleUrl);
    const warmer = new ModuleWarmer();
    await warmer.warm();
    assert.ok(warmer.module instanceof WebAssembly.Module);
    assert.equal(requested.length, 6);
    assert.ok(requested.every((url) => url.startsWith('https://daydream.test/nested/')));
    assert.ok(requested.includes('https://daydream.test/nested/holosphere_wasm.wasm?v=abc123'));
    assert.equal(timers.size, 0);
    assert.deepEqual(cleared, [{ delay: WARM_DEADLINE_MS }]);
  } finally {
    hooks.deregister();
  }
});
