//
// scripts/browser.mjs picks the browser the six headless-Chrome probes drive.
// Nothing is ever downloaded, so a machine or a runner image with no Chrome must
// fail loudly: a resolver that quietly answered nothing would let
// scripts/browser-smoke.mjs and the five page probes report a green run over
// zero pages and zero gestures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { BROWSER_ARGS, BROWSER_CANDIDATES, resolveBrowser } from '../scripts/browser.mjs';

test('a declared CHROME_PATH is the browser, when it exists', () => {
  assert.equal(resolveBrowser({ CHROME_PATH: process.execPath }), process.execPath);
});

test('a declared CHROME_PATH that does not exist is a refusal, not a fallback', () => {
  assert.throws(
    () => resolveBrowser({ CHROME_PATH: '/no/such/browser' }),
    /CHROME_PATH=\/no\/such\/browser does not exist/,
    'falling back would drive a browser the caller did not ask for');
});

test('with no CHROME_PATH only the standard locations answer', () => {
  const installed = BROWSER_CANDIDATES.filter((path) => existsSync(path));
  if (installed.length === 0) {
    assert.throws(() => resolveBrowser({}), /no Chrome, Chromium or Edge found/);
  } else {
    assert.equal(resolveBrowser({}), installed[0]);
  }
});

test('the launch flags carry the runner a GPU-less rasterizer', () => {
  assert.ok(BROWSER_ARGS.includes('--no-sandbox'));
  assert.ok(BROWSER_ARGS.includes('--use-angle=swiftshader'),
    'a runner has no GPU, and every workbench page renders through WebGL');
  assert.ok(BROWSER_ARGS.includes('--enable-unsafe-swiftshader'));
});
