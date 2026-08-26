import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSh, isolatedGitEnv } from './fixture_repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '../.githooks/pre-push').replace(/\\/g, '/');
const SH = findSh();
const SKIP = SH || process.env.DAYDREAM_HOOK_SH_REQUIRED
  ? false
  : 'no POSIX shell available';

// PATH is emptied inside the shell rather than in the spawn environment, which
// would also stop the shell itself from being resolved.
const WITHOUT_TOOLS = 'PATH=""; export PATH; . "$0"';

test('pre-push refuses a push from a tree that cannot run the suites',
  { skip: SKIP }, (t) => {
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
function runWithTools(root, tools) {
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

test('pre-push refuses a push it cannot run the browser probes for',
  { skip: SKIP }, (t) => {
    const root = fixtureRoot(t);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}\n');
    // Every gate before the browser check answers; only `node -e`, which the
    // hook resolves the browser through, refuses.
    const run = runWithTools(root, {
      node: 'case "$1" in -e) exit 1;; esac\nexit 0',
      npm: 'exit 0',
      git: 'exit 0',
      mktemp: 'f=./vendor-importmap.probe\n: > "$f"\necho "$f"',
      rm: 'exit 0',
    });

    assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /no browser found/);
    assert.doesNotMatch(run.stderr, /vendor-importmap\.js is stale/,
      'the browser refusal is the one that fired, not an earlier gate');
  });

test('pre-push never reports success over a missing tool', () => {
  const lines = readFileSync(HOOK, 'utf8').split(/\r?\n/);
  assert.deepEqual(lines.filter((line) => /\bexit 0\b/.test(line)), [],
    'a hook that can exit 0 early reports success over a suite it never ran');
});
