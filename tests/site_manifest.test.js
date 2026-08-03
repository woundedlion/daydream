// site_manifest.txt is the served set: deploy.yml stages exactly its entries.
// A wildcard `cp` allowlist would publish any future root-level dev script and
// still miss a runtime asset placed in a new directory, so the manifest is
// checked from both sides here — every entry is tracked and present, and every
// asset the served pages reach is covered by an entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'site_manifest.txt';
// Entry points a visitor can load directly; everything else is reached from one
// of them.
const PAGES = [
  'index.html',
  'tools/lissajous.html',
  'tools/mobius.html',
  'tools/palettes.html',
  'tools/solids.html',
];

const read = (path) => readFileSync(resolve(REPO, path), 'utf8');

/** @returns {string[]} Manifest entries, comments and blanks dropped. */
const manifestEntries = () =>
  read(MANIFEST)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/** @returns {Set<string>} Every path git tracks, repo-relative. */
const trackedFiles = () =>
  new Set(
    execFileSync('git', ['-C', REPO, 'ls-files'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean),
  );

/**
 * True when git ignores a path. The tool pages reference offline-only drops
 * under the gitignored /vendor/ tree behind a CDN fallback; those are not served
 * and must not be demanded of the manifest.
 * @param {string} path - Repo-relative path.
 * @returns {boolean} Whether the path is ignored.
 */
const ignored = (path) =>
  spawnSync('git', ['-C', REPO, 'check-ignore', '-q', '--', path]).status === 0;

// Specifiers a module resolves through the import map (three, lil-gui and their
// addons) are bare; only these forms name a file in this repo.
const JS_REF = [
  /(?:import|export)\s[^;'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\bnew\s+(?:URL|Worker)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]/g,
];
// The Emscripten glue locates its binary by plain file name, not by specifier.
const WASM_REF = /['"]([\w.-]+\.wasm)['"]/g;
const HTML_REF = /\b(?:src|href)\s*=\s*"([^"]*)"/g;
const SCRIPT_BODY = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

/**
 * Repo-relative targets a file references. HTML attributes are document-relative
 * URLs; script bodies and modules use ES specifiers.
 * @param {string} path - Repo-relative path of the referencing file.
 * @returns {string[]} Referenced paths, normalized against the file's directory.
 */
const referencesOf = (path) => {
  const src = read(path);
  const raw = [];
  const scan = (text, patterns) => {
    for (const re of patterns) for (const [, v] of text.matchAll(re)) raw.push(v);
  };
  if (path.endsWith('.html')) {
    scan(src, [HTML_REF]);
    for (const [, body] of src.matchAll(SCRIPT_BODY)) scan(body, JS_REF);
  } else {
    scan(src, JS_REF);
  }
  scan(src, [WASM_REF]);

  const base = posix.dirname(path);
  const out = [];
  for (const value of raw) {
    const spec = value.split(/[?#]/)[0];
    // Absolute URLs, protocol-relative hosts, data:/blob: payloads and empty
    // attributes name nothing in the repo.
    if (spec === '' || /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith('//')) continue;
    const target = posix.normalize(posix.join(base, spec));
    assert.ok(!target.startsWith('..'), `${path} references ${spec}, outside the repo`);
    out.push(target);
  }
  return out;
};

test('every site manifest entry is tracked and present', () => {
  const entries = manifestEntries();
  assert.ok(entries.length > 0, `${MANIFEST} lists nothing`);
  assert.deepEqual([...new Set(entries)], entries, `${MANIFEST} repeats an entry`);
  const tracked = trackedFiles();
  for (const entry of entries) {
    assert.doesNotMatch(entry, /^[./]|\\|\/$/,
      `${MANIFEST} entry '${entry}' must be a repo-relative path with forward slashes`);
    assert.ok(existsSync(resolve(REPO, entry)), `${MANIFEST} lists '${entry}', which does not exist`);
    const covers = [...tracked].some((f) => f === entry || f.startsWith(`${entry}/`));
    assert.ok(covers,
      `${MANIFEST} lists '${entry}', which git does not track — it would 404 on Pages`);
  }
});

test('the site manifest covers every asset the served pages reference', () => {
  const entries = manifestEntries();
  const covered = (path) =>
    entries.some((entry) => entry === path || path.startsWith(`${entry}/`));

  const tracked = trackedFiles();
  const seen = new Set();
  const queue = [...PAGES];
  while (queue.length > 0) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    assert.ok(covered(path), `${path} is served but missing from ${MANIFEST}`);
    for (const target of referencesOf(path)) {
      if (!tracked.has(target)) {
        // Only a deliberately gitignored drop may be absent from the deploy
        // checkout; anything else is a reference that 404s on Pages.
        assert.ok(ignored(target),
          `${path} references ${target}, which git neither tracks nor ignores — ` +
            'it would 404 on Pages');
        continue;
      }
      assert.ok(existsSync(resolve(REPO, target)),
        `${path} references ${target}, which does not exist`);
      assert.ok(covered(target),
        `${path} references ${target}, which ${MANIFEST} does not publish — ` +
          'it would 404 on Pages');
      if (/\.(js|html)$/.test(target)) queue.push(target);
    }
  }
  // A walk that stops at the entry pages proves nothing about the graph.
  assert.ok(seen.size > PAGES.length, 'the reference walk reached no modules');
});

test('the deploy workflow stages the site from the committed manifest', () => {
  const workflow = read('.github/workflows/deploy.yml');
  assert.match(workflow, /site_manifest\.txt/,
    'deploy.yml must stage _site from the committed manifest');
  assert.doesNotMatch(workflow, /^\s*cp\b.*\*/m,
    'deploy.yml stages a wildcard set, which the manifest cannot constrain');
});
