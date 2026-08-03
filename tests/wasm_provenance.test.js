// Verify the installed WASM artifacts against the provenance recorded beside
// them. deploy.yml runs the same checks, but only after a push has already made
// master public, so a dirty or partial engine install turns a public deploy red.
//
// Every artifact is read from HEAD rather than the working tree: a checkout
// mid-`cmake --install` carries rebuilt binaries that were never committed, and
// only committed content is what gets pushed and deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'holosphere_wasm.wasm.sha256';
const PIN = 'holosphere_wasm.sha';
const BINARY = 'holosphere_wasm.wasm';
const GLUE = 'holosphere_wasm.js';
const TOOLCHAIN = 'holosphere_wasm.toolchain';

/**
 * Runs git in the repo.
 * @param {string[]} args - Arguments after `-C <repo>`.
 * @param {'utf8'|'buffer'} encoding - Output form.
 * @returns {string|Buffer} Command stdout.
 */
const git = (args, encoding) =>
  execFileSync('git', ['-C', REPO, ...args], {
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });

/**
 * Committed bytes of a tracked path.
 * @param {string} path - Repo-relative path.
 * @returns {Buffer} Blob content at HEAD.
 */
const committed = (path) => git(['show', `HEAD:${path}`], 'buffer');

/**
 * Parses `sha256sum` output: `<hex><two spaces or space-star><name>`.
 * @param {string} text - Manifest content.
 * @returns {Map<string, string>} File name to recorded hash.
 */
const parseManifest = (text) => {
  const entries = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^([0-9a-f]{64}) [ *](.+?)\s*$/);
    if (m) entries.set(m[2], m[1]);
  }
  return entries;
};

test('the committed WASM artifacts match their recorded build hashes', () => {
  const recorded = parseManifest(committed(MANIFEST).toString('utf8'));
  // The glue entry is what binds the Emscripten loader to the binary; without
  // it a half-installed pair (new .wasm, stale .js) still hashes clean.
  assert.deepEqual([...recorded.keys()].sort(), [GLUE, BINARY].sort(),
    `${MANIFEST} must record exactly ${BINARY} and ${GLUE}`);
  for (const [name, hash] of recorded) {
    const actual = createHash('sha256').update(committed(name)).digest('hex');
    assert.equal(actual, hash,
      `committed ${name} does not match the hash recorded in ${MANIFEST} — ` +
        're-run the Holosphere WASM install and commit all four artifacts together');
  }
});

test('the engine source pin is a bare, clean engine SHA', () => {
  const pin = committed(PIN).toString('utf8').trim();
  assert.doesNotMatch(pin, /dirty/,
    `${PIN} pins a dirty engine tree ('${pin}') — the deploy gate cannot check ` +
      'out that source. Rebuild the WASM from a committed engine checkout.');
  assert.match(pin, /^[0-9a-f]{40}$/,
    `${PIN} must hold a bare 40-hex engine SHA (got '${pin}')`);
});

test('the WASM binary and its engine source pin were committed together', () => {
  const lastTouch = (path) => git(['log', '-1', '--format=%H', '--', path], 'utf8').trim();
  const wasmCommit = lastTouch(BINARY);
  assert.notEqual(wasmCommit, '', `${BINARY} is not tracked`);
  assert.equal(lastTouch(PIN), wasmCommit,
    `${PIN} was committed apart from ${BINARY}, so the engine source pin can ` +
      'name source the binary was not built from');
});

test('the toolchain record names a real emsdk and clang', () => {
  const records = new Map();
  for (const line of committed(TOOLCHAIN).toString('utf8').split('\n')) {
    const m = line.match(/^(\S+) +(\S.*?)\s*$/);
    if (m) records.set(m[1], m[2]);
  }
  assert.deepEqual([...records.keys()].sort(), ['clang', 'emsdk'],
    `${TOOLCHAIN} must record exactly an emsdk and a clang version`);
  for (const [tool, version] of records) {
    assert.match(version, /^\d+\.\d+/,
      `${TOOLCHAIN} records ${tool} as '${version}'; a CMake probe that found ` +
        'nothing writes a placeholder here and the record then means nothing');
  }
});

test('the toolchain record only ever moved with the binary it describes', () => {
  // The install writes the whole provenance set in one pass and only rewrites
  // this file when the versions change, so it legitimately trails a rebuild.
  // Moving on its own is the failure: a hand edit, or a partial install commit.
  const touched = git(['log', '--format=%H', '--', TOOLCHAIN], 'utf8')
    .trim().split('\n').filter(Boolean);
  assert.notEqual(touched.length, 0, `${TOOLCHAIN} is not tracked`);
  for (const sha of touched) {
    const files = git(['show', '--name-only', '--format=', sha], 'utf8')
      .trim().split('\n');
    assert.ok(files.includes(BINARY),
      `${sha.slice(0, 8)} changed ${TOOLCHAIN} without rebuilding ${BINARY}, ` +
        'so the recorded toolchain does not describe the committed module');
  }
});

test('the pre-push hook runs this provenance gate', () => {
  const hook = readFileSync(resolve(REPO, '.githooks/pre-push'), 'utf8');
  assert.match(hook, /tests\/wasm_provenance\.test\.js/,
    'the provenance gate must run from .githooks/pre-push, not only from npm test');
});
