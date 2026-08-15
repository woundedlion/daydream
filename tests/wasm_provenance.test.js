// Verify the installed WASM artifacts against the provenance recorded beside
// them. deploy.yml runs the same checks, but only after a push has already made
// master public, so a dirty or partial engine install turns a public deploy red.
//
// The provenance itself is read from HEAD rather than the working tree: a
// checkout mid-`cmake --install` carries rebuilt binaries that were never
// committed, and only committed content is what gets pushed and deployed. The
// last case closes the gap that opens between the two.
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
const INSTALLED = [BINARY, GLUE, MANIFEST, PIN, TOOLCHAIN];
const CLEAN_ENV = 'DAYDREAM_WASM_CLEAN_REQUIRED';
const ENGINE_ENV = 'HOLOSPHERE_ENGINE_REQUIRED';
const UNIT_SUITE = '.github/workflows/js-unit-suite.yml';

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
 * Fails on a shallow clone, where every path's last touch resolves to the
 * graft commit and the last-touch tests below pass vacuously.
 */
const assertFullHistory = () => {
  assert.equal(git(['rev-parse', '--is-shallow-repository'], 'utf8').trim(), 'false',
    'shallow clone: last-touch history is truncated — fetch full history (fetch-depth: 0)');
};

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
  assertFullHistory();
  const lastTouch = (path) => git(['log', '-1', '--format=%H', '--', path], 'utf8').trim();
  const wasmCommit = lastTouch(BINARY);
  const pinCommit = lastTouch(PIN);
  assert.notEqual(wasmCommit, '', `${BINARY} is not tracked`);
  assert.notEqual(pinCommit, '', `${PIN} is not tracked`);
  if (pinCommit === wasmCommit) return;

  // An engine advance that changes no compiled output leaves git nothing to
  // commit for the binary, so the pin moves alone. Content is the binding then,
  // exactly as it is for the glue.
  const blob = (commit) => git(['rev-parse', `${commit}:${BINARY}`], 'utf8').trim();
  assert.equal(blob(pinCommit), blob('HEAD'),
    `${PIN} moved apart from ${BINARY} over a changed binary, so the engine ` +
      'source pin can name source the binary was not built from');
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
  assertFullHistory();
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

// The checks above all read HEAD, but engine_contract_wasm, color_parity_wasm
// and segment_composite_wasm load the module from the working tree. Where the
// two disagree, a green suite exercised bytes other than the ones being pushed
// and deployed.
//
// A rebuilt-but-uncommitted install is the normal state while an engine change
// is being tested here, so this runs only where the distinction is real:
// .githooks/pre-push and js-unit-suite.yml declare it.
test('the working-tree WASM artifacts are the committed ones', {
  skip: process.env[CLEAN_ENV]
    ? false
    : `set ${CLEAN_ENV} to require the installed artifacts to match HEAD`,
}, () => {
  // .gitattributes pins all five to LF or binary, so a blob's bytes are its
  // checkout bytes even under core.autocrlf, and a raw compare is exact.
  for (const name of INSTALLED) {
    assert.ok(readFileSync(resolve(REPO, name)).equals(committed(name)),
      `the working tree's ${name} differs from HEAD, so the WASM suites loaded ` +
        'a module that is not the committed one and their result says nothing ' +
        'about what gets deployed — commit the installed artifacts together, or ' +
        'restore them with `git checkout -- holosphere_wasm.*`');
  }
});

test('the pre-push hook and the unit-suite workflow arm the working-tree check', () => {
  const hook = readFileSync(resolve(REPO, '.githooks/pre-push'), 'utf8');
  assert.match(hook, /tests\/wasm_provenance\.test\.js/,
    'the provenance gate must run from .githooks/pre-push, not only from npm test');
  assert.match(hook, new RegExp(`${CLEAN_ENV}=`),
    `the hook must set ${CLEAN_ENV}, or the working-tree check never runs before a push`);
  assert.match(readFileSync(resolve(REPO, UNIT_SUITE), 'utf8'),
    new RegExp(`${CLEAN_ENV}:`),
    `the workflow must set ${CLEAN_ENV} too, or the check the hook can be ` +
      'skipped past is armed nowhere the push is measured against');
});

// Every case of tests/engine_source_parity.test.js skips without an engine
// checkout, and its floors declare the file skippable, so no assertion inside it
// survives losing the workflow's checkout step. This file never skips.
test('the unit-suite workflow declares the engine required', () => {
  const workflow = readFileSync(resolve(REPO, UNIT_SUITE), 'utf8');
  assert.match(workflow, new RegExp(`${ENGINE_ENV}:`),
    `the workflow must set ${ENGINE_ENV}, or a job that lost its engine ` +
      'checkout retires every source-parity case as a skip and still reports green');
});

test('the deploy gate requires the engine CI that built the module', () => {
  const workflow = readFileSync(resolve(REPO, '.github/workflows/deploy.yml'), 'utf8');
  const step = workflow.match(/- name: Require the engine's own CI green[\s\S]*?\n\n/)?.[0];
  assert.ok(step, 'deploy.yml must still gate on the engine CI at the pinned SHA');
  assert.match(step, /commits\/\$PIN\/check-runs/,
    'the check must be read at the pinned SHA, not at engine HEAD');
  assert.match(step, /"CI green"/,
    'the aggregate check is the one that covers the engine WASM job');
  assert.match(step, /exit 1/, 'an unreadable or non-green check must fail the gate');
});

test('the deploy gate checks the recorded toolchain against the engine pin', () => {
  const workflow = readFileSync(resolve(REPO, '.github/workflows/deploy.yml'), 'utf8');
  const step = workflow.match(/- name: Verify the recorded build toolchain[\s\S]*?\n\n/)?.[0];
  assert.ok(step, `deploy.yml must still compare ${TOOLCHAIN} against the pinned engine`);
  assert.match(step, /build_pins\.py emsdk/,
    'the engine\'s own pin is what the recorded emsdk has to agree with; the ' +
      'shape check above passes for any version a local unpinned emsdk writes');
  assert.match(step, /engine\/tools\/build_pins\.py/,
    'the pin must be read from the pinned engine checkout, not from engine HEAD');
  assert.match(step, /exit 1/, 'a mismatched or unreadable pin must fail the gate');
});

test('the deploy gate binds a lone pin move to the binary by content', () => {
  const workflow = readFileSync(resolve(REPO, '.github/workflows/deploy.yml'), 'utf8');
  const step = workflow.match(/- name: Verify the installed WASM and source pin[\s\S]*?\n\n/)?.[0];
  assert.ok(step, 'deploy.yml must still check the WASM/pin last-touch commits');
  assert.match(step, /rev-parse "\$sha_c:holosphere_wasm\.wasm"/,
    'without the content comparison, an engine advance that changes no compiled ' +
      'output can never be deployed: git has nothing to commit for the binary');
  assert.match(step, /exit 1/, 'a pin that moved over a changed binary must fail the gate');
});
