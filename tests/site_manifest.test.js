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
import { manifestEntries, servedPages } from './site_pages.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'site_manifest.txt';
const PAGES = servedPages();

const read = (path) => readFileSync(resolve(REPO, path), 'utf8');

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
  /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\bnew\s+(?:URL|Worker)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]/g,
];
// The Emscripten glue locates its binary by plain file name, not by specifier.
const WASM_REF = /['"]([\w.-]+\.wasm)['"]/g;
const HTML_REF = /\b(?:src|href)\s*=\s*"([^"]*)"/g;
const CSS_REF = /\burl\(\s*['"]?([^'")]+?)['"]?\s*\)/g;
const SCRIPT_BODY = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
const STYLE_BODY = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

/**
 * Repo-relative targets a file references. HTML attributes are document-relative
 * URLs; script bodies and modules use ES specifiers; style bodies and
 * stylesheets use url().
 * @param {string} path - Repo-relative path of the referencing file.
 * @returns {{targets: string[], escaping: string[]}} Referenced paths normalized
 *   against the file's directory, and those that normalize outside the repo.
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
    for (const [, body] of src.matchAll(STYLE_BODY)) scan(body, [CSS_REF]);
  } else if (path.endsWith('.css')) {
    scan(src, [CSS_REF]);
  } else {
    scan(src, JS_REF);
  }
  scan(src, [WASM_REF]);

  const base = posix.dirname(path);
  const targets = [];
  const escaping = [];
  for (const value of raw) {
    const spec = value.split(/[?#]/)[0];
    // Absolute URLs, protocol-relative hosts, data:/blob: payloads and empty
    // attributes name nothing in the repo.
    if (spec === '' || /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith('//')) continue;
    const target = posix.normalize(posix.join(base, spec));
    if (target.startsWith('..')) escaping.push(`${path} -> ${spec}`);
    else targets.push(target);
  }
  return { targets, escaping };
};

test('every site manifest entry is tracked and present', () => {
  const entries = manifestEntries();
  assert.ok(entries.length > 0, `${MANIFEST} lists nothing`);
  assert.deepEqual([...new Set(entries)], entries, `${MANIFEST} repeats an entry`);
  const tracked = trackedFiles();
  // Accumulated rather than asserted per entry, so the assertion count does not
  // track the manifest's length.
  const malformed = [];
  const absent = [];
  const untracked = [];
  for (const entry of entries) {
    if (/^[./]|\\|\/$/.test(entry)) malformed.push(entry);
    if (!existsSync(resolve(REPO, entry))) absent.push(entry);
    if (![...tracked].some((f) => f === entry || f.startsWith(`${entry}/`)))
      untracked.push(entry);
  }
  assert.deepEqual(malformed.slice(0, 5), [],
    `${malformed.length} ${MANIFEST} entries are not repo-relative forward-slashed paths`);
  assert.deepEqual(absent.slice(0, 5), [],
    `${absent.length} ${MANIFEST} entries do not exist`);
  assert.deepEqual(untracked.slice(0, 5), [],
    `${untracked.length} ${MANIFEST} entries git does not track — they would 404 on Pages`);
});

test('the derived page roster names every served page', () => {
  const entries = manifestEntries();
  const covered = (path) =>
    entries.some((entry) => entry === path || path.startsWith(`${entry}/`));

  const pages = new Set(PAGES);
  assert.ok(pages.size > 0, `${MANIFEST} publishes no page`);
  // A manifest entry may name a directory, which ships recursively; a page under
  // one is served without appearing as an entry of its own.
  const unlisted = [...trackedFiles()].filter(
    (file) => file.endsWith('.html') && covered(file) && !pages.has(file));
  assert.deepEqual(unlisted.slice(0, 5), [],
    `${unlisted.length} served pages are named by no ${MANIFEST} entry, so the ` +
      'CSP and stylesheet cases never see them');
});

/**
 * Reference walk from the served pages over the tracked tree.
 * @returns {{seen: Set<string>, unpublished: string[], dangling: string[],
 *   absent: string[], escaping: string[]}} Every path reached, and the
 *   references that name nothing servable.
 */
const walkFromPages = () => {
  const entries = manifestEntries();
  const covered = (path) =>
    entries.some((entry) => entry === path || path.startsWith(`${entry}/`));

  const tracked = trackedFiles();
  const seen = new Set();
  const queue = [...PAGES];
  // The walk visits every reachable file, so it accumulates its findings and
  // its caller asserts once per class rather than once per node.
  const unpublished = [];
  const dangling = [];
  const absent = [];
  const escaping = [];
  while (queue.length > 0) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!covered(path)) unpublished.push(path);
    const refs = referencesOf(path);
    escaping.push(...refs.escaping);
    for (const target of refs.targets) {
      if (!tracked.has(target)) {
        // Only a deliberately gitignored drop may be absent from the deploy
        // checkout; anything else is a reference that 404s on Pages.
        if (!ignored(target)) dangling.push(`${path} -> ${target}`);
        continue;
      }
      if (!existsSync(resolve(REPO, target))) absent.push(`${path} -> ${target}`);
      else if (!covered(target)) unpublished.push(`${path} -> ${target}`);
      if (/\.(js|html|css)$/.test(target)) queue.push(target);
      else seen.add(target);
    }
  }
  return { seen, unpublished, dangling, absent, escaping };
};

test('the site manifest covers every asset the served pages reference', () => {
  const { seen, unpublished, dangling, absent, escaping } = walkFromPages();
  assert.deepEqual(escaping.slice(0, 5), [],
    `${escaping.length} references normalize outside the repo`);
  assert.deepEqual(absent.slice(0, 5), [],
    `${absent.length} references name a tracked path that does not exist`);
  assert.deepEqual(dangling.slice(0, 5), [],
    `${dangling.length} references git neither tracks nor ignores — they would ` +
      '404 on Pages');
  assert.deepEqual(unpublished.slice(0, 5), [],
    `${unpublished.length} served paths ${MANIFEST} does not publish — they ` +
      'would 404 on Pages');
  // A walk that stops at the entry pages proves nothing about the graph.
  assert.ok(seen.size > PAGES.length, 'the reference walk reached no modules');
});

// Entries no served page references. The manifest exists to keep tests/,
// scripts/ and dev tooling off Pages, so this list stays short: an entry earns a
// place here only by being published for its own sake.
const UNREFERENCED = ['README.md', 'docs/screenshots'];

test('the site manifest publishes nothing the served pages do not reach', () => {
  const entries = manifestEntries();
  const stale = UNREFERENCED.filter((entry) => !entries.includes(entry));
  assert.deepEqual(stale, [],
    `the unreferenced allowlist names paths ${MANIFEST} no longer publishes`);

  const { seen } = walkFromPages();
  const reached = (entry) =>
    seen.has(entry) || [...seen].some((path) => path.startsWith(`${entry}/`));
  const unreached = entries.filter(
    (entry) => !UNREFERENCED.includes(entry) && !reached(entry));
  assert.deepEqual(unreached.slice(0, 5), [],
    `${unreached.length} ${MANIFEST} entries are neither a served page, ` +
      'reachable from one, nor declared unreferenced — the manifest is the only ' +
      'thing keeping dev tooling off Pages');
});

test('the deploy workflow stages the site from the committed manifest', () => {
  const workflow = read('.github/workflows/deploy.yml');
  assert.match(workflow, /site_manifest\.txt/,
    'deploy.yml must stage _site from the committed manifest');
  assert.doesNotMatch(workflow, /^\s*cp\b.*\*/m,
    'deploy.yml stages a wildcard set, which the manifest cannot constrain');
});
