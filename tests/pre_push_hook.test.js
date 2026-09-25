import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSh, isolatedGitEnv } from './helpers/fixture_repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '../.githooks/pre-push').replace(/\\/g, '/');
const SH = findSh();
const MISSING_SH = 'no POSIX shell available';
const SKIP = SH || process.env.DAYDREAM_HOOK_SH_REQUIRED
  ? false
  : MISSING_SH;

// PATH is emptied inside the shell rather than in the spawn environment, which
// would also stop the shell itself from being resolved.
const WITHOUT_TOOLS = 'PATH=""; export PATH; . "$0"';

test('pre-push refuses a push from a tree that cannot run the suites',
  { skip: SKIP }, (t) => {
    assert.ok(SH, MISSING_SH);
    const root = mkdtempSync(join(tmpdir(), 'pre-push-hook-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = isolatedGitEnv();
    delete env.NODE_TEST_CONTEXT;

    const run = spawnSync(SH, ['-c', WITHOUT_TOOLS, HOOK], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /node not found/);
  });

/**
 * Runs the hook with PATH pointing at a directory of stand-in tools, so a
 * refusal further down the hook than the first missing tool still executes.
 * PATH is set inside the shell rather than in the spawn environment, which
 * would also stop the shell itself from being resolved.
 * @param {string} root - Working directory the hook runs in.
 * @param {Object<string, string>} tools - Stand-in name to shell body.
 * @returns {Object} The spawnSync result.
 */
function runWithTools(root, tools, input = '') {
  assert.ok(SH, MISSING_SH);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const env = isolatedGitEnv();
  delete env.NODE_TEST_CONTEXT;
  // MSYS reads PATH as POSIX, so a drive letter would split on its colon.
  const posixBin = bin.replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_all, drive) => `/${drive.toLowerCase()}`);
  return spawnSync(SH, ['-c', `PATH="${posixBin}"; export PATH; . "$0"`, HOOK], {
    cwd: root,
    env,
    encoding: 'utf8',
    input,
  });
}

/** A fixture root removed when the case ends. @returns {string} The root. */
function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'pre-push-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('pre-push refuses a push from a tree that cannot install the suites',
  { skip: SKIP }, (t) => {
    const root = fixtureRoot(t);
    // node answers, so the refusal is reached at the next tool rather than the
    // first: a hook that stopped checking npm would run the suites through it.
    const run = runWithTools(root, { node: 'exit 0' });

    assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /npm not found/);
  });

test('pre-push runs the source checks successfully',
  { skip: SKIP }, (t) => {
    const root = fixtureRoot(t);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}\n');
    const run = runWithTools(root, {
      node: 'exit 0',
      npm: 'exit 0',
      git: 'exit 0',
      mktemp: 'f=./vendor-importmap.probe\n: > "$f"\necho "$f"',
      rm: 'exit 0',
    });

    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  });

test('pre-push refuses a stale working-tree import map', { skip: SKIP }, (t) => {
  const root = fixtureRoot(t);
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}\n');
  writeFileSync(join(root, 'vendor-importmap.js'), 'stale\n');
  const git = spawnSync(SH, ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const run = runWithTools(root, {
    node: 'exit 0',
    npm: 'if [ "$2" = importmap ]; then for last; do :; done; echo fresh > "$last"; fi',
    git: `exec "${git}" "$@"`,
    mktemp: 'f=./vendor-importmap.probe\n: > "$f"\necho "$f"',
    rm: 'exit 0',
  });
  assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /vendor-importmap\.js is stale/);
});

test('pre-push refuses a failing source workflow suite',
  { skip: SKIP }, (t) => {
    const root = fixtureRoot(t);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}\n');
    const run = runWithTools(root, {
      node: 'echo unit-suite-failed >&2; exit 7',
      npm: 'exit 0',
      git: 'exit 0',
      mktemp: 'f=./vendor-importmap.probe\n: > "$f"\necho "$f"',
      rm: 'exit 0',
    });
    assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /unit-suite-failed/);
  });

for (const step of ['lint', 'typecheck', 'importmap']) {
  test(`pre-push stops when ${step} fails`, { skip: SKIP }, (t) => {
    const root = fixtureRoot(t);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}\n');
    const run = runWithTools(root, {
      node: 'echo unexpected-unit-suite >&2; exit 0',
      npm: `if [ "$2" = ${step} ]; then echo ${step}-failed >&2; exit 7; fi`,
      git: 'exit 0',
      mktemp: 'echo ./vendor-importmap.probe',
      rm: 'exit 0',
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, new RegExp(`${step}-failed`));
    assert.doesNotMatch(run.stderr, /unexpected-unit-suite/);
  });
}

test('pre-push requires installed dependencies', { skip: SKIP }, (t) => {
  const run = runWithTools(fixtureRoot(t), {
    node: 'exit 0', npm: 'echo unexpected-npm >&2; exit 0', git: 'exit 0',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /node_modules is missing/);
  assert.doesNotMatch(run.stderr, /unexpected-npm/);
});

test('pre-push accepts a ref deletion without running source checks', { skip: SKIP }, (t) => {
  const root = fixtureRoot(t);
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}');
  const run = runWithTools(root, {
    node: 'echo unexpected-node >&2; exit 17',
    npm: 'echo unexpected-npm >&2; exit 17',
    git: '[ "$1" = rev-parse ] && [ "$2" = --local-env-vars ] && exit 0; echo unexpected-git >&2; exit 17',
  }, `refs/heads/topic ${'0'.repeat(40)} refs/heads/topic ${'1'.repeat(40)}\n`);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stderr, '');
});

for (const installStatus of [0, 19]) {
  test(`pre-push installs snapshot dependencies and propagates install status ${installStatus}`,
    { skip: SKIP }, (t) => {
      const root = fixtureRoot(t);
      const env = isolatedGitEnv();
      const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
      for (const directory of ['.githooks', 'tests', 'node_modules', 'bin'])
        mkdirSync(join(root, directory));
      writeFileSync(join(root, '.githooks/pre-push'), readFileSync(HOOK));
      writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}');
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'package-lock.json'), '{}');
      writeFileSync(join(root, 'vendor-importmap.js'), 'map\n');
      for (const name of ['ci_workflow', 'deployment_pair', 'stage_site'])
        writeFileSync(join(root, `tests/${name}.test.js`), '');
      const log = join(root, 'calls.log').replace(/\\/g, '/');
      const npm = join(root, 'bin/npm');
      writeFileSync(npm, '#!/bin/sh\n'
        + `printf '%s\\n' "$*" >> "${log}"\n`
        + `if [ "$1" = ci ]; then mkdir -p node_modules; echo '{}' > node_modules/.package-lock.json; exit ${installStatus}; fi\n`
        + 'if [ "$2" = importmap ]; then for last; do :; done; cp vendor-importmap.js "$last"; fi\n');
      chmodSync(npm, 0o755);
      git('init', '-q');
      git('add', '.githooks/pre-push', 'tests', 'package.json', 'package-lock.json', 'vendor-importmap.js');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
        '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
      const sha = git('rev-parse', 'HEAD').trim();
      const changedPackage = '{"private":true}\n';
      writeFileSync(join(root, 'package.json'), changedPackage);
      const posixBin = join(root, 'bin').replace(/\\/g, '/')
        .replace(/^([A-Za-z]):/, (all, drive) => `/${drive.toLowerCase()}`);
      const result = spawnSync(SH, ['-c', `PATH="${posixBin}:$PATH"; export PATH; . "$0"`, HOOK], {
        cwd: root, env, encoding: 'utf8',
        input: `refs/heads/master ${sha} refs/heads/master ${'0'.repeat(40)}\n`,
      });
      const calls = readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n');
      assert.equal(calls[0], 'ci --ignore-scripts');
      if (installStatus === 0) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(calls.slice(1, 3), ['run lint', 'run typecheck']);
        assert.match(calls[3], /^run importmap -- --out /);
      } else {
        assert.notEqual(result.status, 0);
        assert.deepEqual(calls, ['ci --ignore-scripts']);
      }
      assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), changedPackage);
      assert.equal(readFileSync(join(root, 'node_modules/.package-lock.json'), 'utf8'), '{}');
    });
}

test('pre-push validates the pushed commit instead of a modified working tree', { skip: SKIP }, (t) => {
  const root = fixtureRoot(t);
  const env = isolatedGitEnv();
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
  mkdirSync(join(root, '.githooks'));
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, '.githooks/pre-push'), readFileSync(HOOK));
  writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}');
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'vendor-importmap.js'), 'map\n');
  writeFileSync(join(root, 'marker'), 'committed\n');
  for (const name of ['ci_workflow', 'deployment_pair', 'stage_site'])
    writeFileSync(join(root, `tests/${name}.test.js`), '');
  const calls = join(root, 'tool-calls').replace(/\\/g, '/');
  const node = join(root, 'bin/node');
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "node $*" >> '${calls}'\nexec '${process.execPath.replace(/\\/g, '/')}' "$@"\n`);
  chmodSync(node, 0o755);
  const npm = join(root, 'bin/npm');
  writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' "npm $*" >> '${calls}'\n` + '[ "$(cat marker)" = committed ] || exit 23\n'
    + 'if [ "$2" = importmap ]; then for last; do :; done; cp vendor-importmap.js "$last"; fi\n');
  chmodSync(npm, 0o755);
  git('init', '-q');
  git('add', '.githooks/pre-push', 'tests', 'package.json', 'package-lock.json', 'vendor-importmap.js', 'marker');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'marker'), 'working-tree-only\n');
  const posixBin = join(root, 'bin').replace(/\\/g, '/').replace(/^([A-Za-z]):/, (all, drive) => `/${drive.toLowerCase()}`);
  const result = spawnSync(SH, ['-c', `PATH="${posixBin}:$PATH"; export PATH; . "$0"`, HOOK], {
    cwd: root, env, encoding: 'utf8', input: `refs/heads/master ${sha} refs/heads/master ${'0'.repeat(40)}\n`,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const logged = readFileSync(calls, 'utf8');
  for (const command of ['npm run lint', 'npm run typecheck', 'npm run importmap', 'node --test'])
    assert.ok(logged.includes(command), command);
  assert.equal(readFileSync(join(root, 'marker'), 'utf8'), 'working-tree-only\n');
  assert.equal(readFileSync(join(root, 'node_modules/.package-lock.json'), 'utf8'), '{}');
});
