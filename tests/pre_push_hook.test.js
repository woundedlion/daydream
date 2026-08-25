import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('pre-push never reports success over a missing tool', () => {
  const lines = readFileSync(HOOK, 'utf8').split(/\r?\n/);
  assert.deepEqual(lines.filter((line) => /\bexit 0\b/.test(line)), []);
  for (const missing of [/node not found/, /npm not found/, /no browser found/]) {
    const at = lines.findIndex((line) => missing.test(line));
    assert.notEqual(at, -1, `the hook no longer reports ${missing}`);
    assert.match(lines[at + 1], /^\s*exit 1$/,
      `${missing} must be followed by a non-zero exit`);
  }
});
