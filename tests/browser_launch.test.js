//
// scripts/browser.mjs picks the browser the six headless-Chrome probes drive.
// Nothing is ever downloaded, so a machine or a runner image with no Chrome must
// fail loudly: a resolver that quietly answered nothing would let
// scripts/browser-smoke.mjs and the five page probes report a green run over
// zero pages and zero gestures.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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

// Driven over a candidate list of their own, so a runner that happens to carry
// Chrome covers the refusal this module exists for and one that does not still
// covers the first-match walk.
test('with no CHROME_PATH and no candidate installed, nothing is answered', () => {
  assert.throws(
    () => resolveBrowser({}, ['/no/such/chrome', '/no/such/edge']),
    /no Chrome, Chromium or Edge found[\s\S]*\/no\/such\/chrome, \/no\/such\/edge/,
    'answering nothing would report a green run over zero pages and zero gestures');
});

test('with no CHROME_PATH the first installed candidate answers', () => {
  assert.equal(
    resolveBrowser({}, ['/no/such/chrome', process.execPath, '/no/such/edge']),
    process.execPath,
    'a missing earlier candidate is skipped rather than preferred');
});

// Same result either way on any machine: installed or not, the default search
// list is the exported one.
test('an undeclared resolve searches the standard locations', () => {
  const attempt = (...args) => {
    try {
      return resolveBrowser(...args);
    } catch (error) {
      return error.message;
    }
  };
  assert.equal(attempt({}), attempt({}, BROWSER_CANDIDATES));
  assert.ok(BROWSER_CANDIDATES.includes('/usr/bin/google-chrome'),
    'the headless jobs run on Linux');
  for (const path of BROWSER_CANDIDATES) assert.match(path, /chrome|chromium|edge/i);
});

test('the launch flags carry the runner a GPU-less rasterizer', () => {
  assert.ok(BROWSER_ARGS.includes('--no-sandbox'));
  assert.ok(BROWSER_ARGS.includes('--use-angle=swiftshader'),
    'a runner has no GPU, and every workbench page renders through WebGL');
  assert.ok(BROWSER_ARGS.includes('--enable-unsafe-swiftshader'));
});

test('the launch flags put the vendor CDN beyond every probe', () => {
  assert.ok(BROWSER_ARGS.includes('--host-resolver-rules=MAP cdn.jsdelivr.net ~NOTFOUND'),
    'the probes are served three.js and lil-gui from their own origin; a page '
      + 'that reached jsdelivr instead would hand a CDN incident the power to '
      + 'red the required gate');
});
