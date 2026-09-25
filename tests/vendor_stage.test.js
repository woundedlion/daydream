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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { serveStagedSite, stageSite } from '../scripts/vendor-stage.mjs';
import { manifestEntries } from './helpers/site_pages.js';
import { request } from './helpers/http_request.js';

const staged = stageSite();
after(() => rmSync(staged.root, { recursive: true, force: true }));

const stagedFile = (path) => readFileSync(join(staged.root, path), 'utf8');

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
  for (const entry of [...manifestEntries(), 'three.js/build/three.module.js', 'node_modules/lil-gui/dist/lil-gui.esm.min.js']) {
    assert.ok(staged.entries.includes(entry), `${entry} is not served`);
  }
});

test('the staged site serves the libraries, and drops its tree on close', async () => {
  const site = await serveStagedSite();
  try {
    assert.ok(existsSync(site.root), 'the served staging directory exists');
    assert.notEqual(site.root, staged.root, 'each staging operation owns its directory');
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
  assert.equal(existsSync(site.root), false, 'the scratch tree outlived its server');
  assert.ok(existsSync(staged.root), 'closing the server preserves another staged tree');
});
