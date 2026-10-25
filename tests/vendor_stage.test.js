// scripts/vendor-stage.mjs stages the published site with three.js and lil-gui
// linked out of node_modules and an import map generated to resolve them there.
// The committed map must stay all-CDN, which the shared inode behind a
// hard-linked file would break.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { serveStagedSite, stageProbeSite } from '../scripts/vendor-stage.mjs';
import { manifestEntries } from './helpers/site_pages.js';
import { request } from './helpers/http_request.js';

const staged = stageProbeSite();
after(() => rmSync(staged.root, { recursive: true, force: true }));

const stagedFile = (path) => readFileSync(join(staged.root, path), 'utf8');

test('the staged import map resolves both libraries locally', () => {
  const map = stagedFile('vendor-importmap.js');
  assert.match(map, /const VENDOR = \{ three: 'local', lilGui: 'local' \};/);
  assert.doesNotMatch(map.split('// === END GENERATED ===')[0], /jsdelivr/,
    'a staged library still pinned to the CDN would red the gate on an outage');
});

test('the committed import map is untouched by staging', () => {
  const committed = readFileSync(new URL('../vendor-importmap.js', import.meta.url), 'utf8');
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
  const entries = manifestEntries();
  assert.ok(entries.length > 0, 'the manifest lists no entries');
  for (const entry of entries) {
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


test('staging copies files when hard links cross filesystem boundaries', (t) => {
  const source = fileURLToPath(new URL('../index.html', import.meta.url));
  const original = readFileSync(source, 'utf8');
  const link = fs.linkSync;
  let refused = 0;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (from === source) {
      refused++;
      throw Object.assign(new Error('Cross-device link'), { code: 'EXDEV' });
    }
    return link(from, to);
  });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  syncBuiltinESMExports();

  const copy = stageProbeSite();
  t.after(() => rmSync(copy.root, { recursive: true, force: true }));
  const target = join(copy.root, 'index.html');
  assert.equal(refused, 1);
  assert.equal(readFileSync(target, 'utf8'), original);
  fs.writeFileSync(target, 'changed staged content');
  assert.equal(readFileSync(source, 'utf8'), original);
});

test('staging reports a missing dependency and removes its partial tree', (t) => {
  const dependency = fileURLToPath(new URL('../node_modules/three/build', import.meta.url));
  const exists = fs.existsSync;
  const makeTemp = fs.mkdtempSync;
  let partial;
  t.mock.method(fs, 'existsSync', (path) => path === dependency ? false : exists(path));
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    partial = makeTemp(...args);
    return partial;
  });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  syncBuiltinESMExports();

  assert.throws(() => stageProbeSite(), /three\/build is missing.*npm ci/);
  assert.ok(partial);
  assert.equal(exists(partial), false);
  assert.equal(exists(dependency), true);
});

test('CDN smoke stages an external import map without changing the committed map', (t) => {
  const previous = process.env.HS_CDN_SMOKE;
  t.after(() => {
    if (previous === undefined) delete process.env.HS_CDN_SMOKE;
    else process.env.HS_CDN_SMOKE = previous;
  });
  process.env.HS_CDN_SMOKE = '1';
  const site = stageProbeSite();
  t.after(() => rmSync(site.root, { recursive: true, force: true }));
  const map = readFileSync(join(site.root, 'vendor-importmap.js'), 'utf8');
  assert.match(map, /const VENDOR = \{ three: 'cdn', lilGui: 'cdn' \};/);
  assert.match(map, /https:\/\/cdn\.jsdelivr\.net/);
  assert.equal(existsSync(join(site.root, 'index.html')), true);
  assert.match(readFileSync(new URL('../vendor-importmap.js', import.meta.url), 'utf8'),
    /const VENDOR = \{ three: 'cdn', lilGui: 'cdn' \};/);
});

test('a server bind failure removes its staged tree and preserves other sites', async (t) => {
  const makeTemp = fs.mkdtempSync;
  let partial;
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    partial = makeTemp(...args);
    return partial;
  });
  t.mock.method(Server.prototype, 'listen', function () {
    this.emit('error', new Error('fixture bind refused'));
    return this;
  });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  syncBuiltinESMExports();
  await assert.rejects(serveStagedSite(), /fixture bind refused/);
  assert.ok(partial);
  assert.equal(existsSync(partial), false);
  assert.equal(existsSync(staged.root), true);
});
