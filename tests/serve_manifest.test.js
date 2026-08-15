//
// scripts/serve-manifest.mjs is the server scripts/browser-smoke.mjs loads its
// pages over. A path it serves beyond site_manifest.txt's set would let the
// smoke pass over a layout Pages never ships, and a .wasm labelled as anything
// but application/wasm drops Emscripten to the ArrayBuffer path — neither shows
// up as a smoke failure, so both are pinned here instead.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { get as httpGet } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MIME, serveManifest } from '../scripts/serve-manifest.mjs';

// A file entry, a binary one, a directory entry that ships recursively, and an
// entry whose file is gone. 'styles' is also the prefix of a path outside it.
const ENTRIES = ['index.html', 'engine.wasm', 'styles', 'gone.js'];

const FILES = {
  'index.html': '<!doctype html>\n',
  'engine.wasm': '\0asm binary\n',
  'styles/index.css': 'body { margin: 0 }\n',
  'styles/fonts/pin.woff2': 'font bytes\n',
  'styles-extra.css': 'not under the styles entry\n',
  'scripts/run-tests.mjs': '// dev tooling\n',
};

// The site root is a subdirectory so a reference escaping it lands on a real
// file, which is what a served traversal would hand out.
const TEMP = mkdtempSync(join(tmpdir(), 'daydream-serve-manifest-'));
const ROOT = join(TEMP, 'site');
for (const [path, body] of Object.entries(FILES)) {
  mkdirSync(dirname(join(ROOT, path)), { recursive: true });
  writeFileSync(join(ROOT, path), body);
}
writeFileSync(join(TEMP, 'outside.txt'), 'above the site root\n');
after(() => rmSync(TEMP, { recursive: true, force: true }));

/**
 * One request against the fixture server. `agent: false` keeps no connection
 * alive, so close() resolves as soon as the case is done.
 * @param {string} origin - Origin the server listens on.
 * @param {string} path - Request path, sent as written.
 * @returns {Promise<{status: number, type: string|undefined, body: string}>} The response.
 */
const request = (origin, path) => new Promise((done, fail) => {
  httpGet(`${origin}${path}`, { agent: false }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => done({
      status: res.statusCode,
      type: res.headers['content-type'],
      body,
    }));
  }).on('error', fail);
});

/**
 * Runs a case against a server over the fixture root.
 * @param {(get: (path: string) => Promise<{status: number, type: string|undefined,
 *   body: string}>) => Promise<void>} body - The case.
 * @returns {Promise<void>} Resolves once the server is shut down.
 */
const withSite = async (body) => {
  const site = await serveManifest(ENTRIES, ROOT);
  try {
    await body((path) => request(site.origin, path));
  } finally {
    await site.close();
  }
};

test('serves the manifest set, and the bare root as index.html', () => withSite(async (get) => {
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.equal(root.body, FILES['index.html']);
  assert.equal(root.type, 'text/html; charset=utf-8');

  const page = await get('/index.html');
  assert.equal(page.status, 200);
  assert.equal(page.body, FILES['index.html']);
}));

test('a directory entry serves recursively', () => withSite(async (get) => {
  const css = await get('/styles/index.css');
  assert.equal(css.status, 200);
  assert.equal(css.body, FILES['styles/index.css']);
  assert.equal(css.type, 'text/css; charset=utf-8');

  const nested = await get('/styles/fonts/pin.woff2');
  assert.equal(nested.status, 200);
  assert.equal(nested.type, 'application/octet-stream',
    'an extension the table does not name has no MIME type to guess');

  assert.equal((await get('/styles')).status, 404,
    'the directory itself is not a file, so there is nothing to send');
}));

test('a .wasm is served as application/wasm', () => withSite(async (get) => {
  const wasm = await get('/engine.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.type, 'application/wasm',
    'any other type drops Emscripten to the ArrayBuffer path');
  assert.equal(MIME['.wasm'], 'application/wasm');
}));

test('nothing outside the manifest set is served', () => withSite(async (get) => {
  const tooling = await get('/scripts/run-tests.mjs');
  assert.equal(tooling.status, 404, 'dev tooling the manifest omits was served');
  assert.equal(tooling.body, 'not in site_manifest.txt\n');
  assert.equal(tooling.type, 'text/plain; charset=utf-8');

  assert.equal((await get('/styles-extra.css')).status, 404,
    'an entry covers a path only at a segment boundary');
  assert.equal((await get('/gone.js')).status, 404,
    'an entry whose file is missing has nothing to serve');
}));

test('a path that escapes the site root is refused', () => withSite(async (get) => {
  // The URL parser resolves a plain `..` segment away before the server sees
  // it, so the traversal a served path could carry is the encoded one.
  assert.equal((await get('/styles/%2e%2e%2f%2e%2e%2foutside.txt')).status, 404,
    'a reference under a manifest entry escaped the site root');
  assert.equal((await get('/%2e%2e%2foutside.txt')).status, 404);
}));
