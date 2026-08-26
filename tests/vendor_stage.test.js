//
// scripts/vendor-stage.mjs is what keeps the required browser gate off
// cdn.jsdelivr.net: it stages the published site with three.js and lil-gui
// linked out of node_modules and an import map generated to resolve them there.
// A staged tree that fell back to the CDN would still pass every probe on a
// good day and red the gate on a CDN incident, so the resolution is pinned
// here. The committed map must stay all-CDN either way — the deploy serves it —
// which the shared inode behind a hard-linked file would quietly break.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { get as httpGet } from 'node:http';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serveStagedSite, stageSite } from '../scripts/vendor-stage.mjs';
import { manifestEntries } from './site_pages.js';

const staged = stageSite();
after(() => rmSync(staged.root, { recursive: true, force: true }));

const stagedFile = (path) => readFileSync(join(staged.root, path), 'utf8');

/**
 * The scratch trees staging has left behind.
 * @returns {string[]} Their names under the temp directory, sorted.
 */
const scratchDirs = () => readdirSync(tmpdir())
  .filter((name) => name.startsWith('daydream-staged-site-'))
  .sort();

/**
 * One request against a running site.
 * @param {string} origin - Origin the server listens on.
 * @param {string} path - Request path.
 * @returns {Promise<{status: number, body: string}>} The response.
 */
const request = (origin, path) => new Promise((done, fail) => {
  httpGet(`${origin}${path}`, { agent: false }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => done({ status: res.statusCode ?? 0, body }));
  }).on('error', fail);
});

test('the staged import map resolves both libraries locally', () => {
  const map = stagedFile('vendor-importmap.js');
  assert.match(map, /const VENDOR = \{ three: 'local', lilGui: 'local' \};/);
  assert.doesNotMatch(map.split('// === END GENERATED ===')[0], /jsdelivr/,
    'a staged library still pinned to the CDN would red the gate on an outage');
});

test('the committed import map is untouched by staging', () => {
  const committed = readFileSync('vendor-importmap.js', 'utf8');
  assert.match(committed, /const VENDOR = \{ three: 'cdn', lilGui: 'cdn' \};/,
    'the deploy serves this file; a local block would 404 on Pages');
});

test('the vendored entry points are staged where the local map looks', () => {
  for (const path of [
    'three.js/build/three.module.js',
    'three.js/examples/jsm/controls/OrbitControls.js',
    'three.js/examples/jsm/renderers/CSS2DRenderer.js',
    'node_modules/lil-gui/dist/lil-gui.esm.min.js',
  ]) {
    assert.ok(existsSync(join(staged.root, path)), `${path} was not staged`);
  }
});

test('the staged tree carries the manifest set', () => {
  for (const entry of manifestEntries()) {
    assert.ok(existsSync(join(staged.root, entry)), `${entry} was not staged`);
  }
});

test('the served set covers the vendored trees as well as the manifest', () => {
  for (const entry of [...manifestEntries(), 'three.js', 'node_modules']) {
    assert.ok(staged.entries.includes(entry), `${entry} is not served`);
  }
});

test('the staged site serves the libraries, and drops its tree on close', async () => {
  const before = scratchDirs();
  const site = await serveStagedSite();
  assert.equal(scratchDirs().length, before.length + 1,
    'serving stages exactly one scratch tree');
  try {
    const map = await request(site.origin, '/vendor-importmap.js');
    assert.equal(map.status, 200);
    assert.match(map.body, /three: 'local'/);

    const three = await request(site.origin, '/three.js/build/three.module.js');
    assert.equal(three.status, 200, 'three must not have to come from the CDN');

    const gui = await request(
      site.origin, '/node_modules/lil-gui/dist/lil-gui.esm.min.js');
    assert.equal(gui.status, 200, 'lil-gui must not have to come from the CDN');

    const tooling = await request(site.origin, '/scripts/vendor-stage.mjs');
    assert.equal(tooling.status, 404,
      'the staged site publishes no more than the manifest set plus the libraries');
  } finally {
    await site.close();
  }
  assert.deepEqual(scratchDirs(), before, 'the scratch tree outlived its server');
});
