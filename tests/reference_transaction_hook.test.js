//
// .githooks/reference-transaction guards refs/heads/master. The hook script is
// driven directly: `sh <hook> <stage>` with a synthesized transaction on stdin,
// against throwaway fixture repos under the OS temp dir, so no case depends on
// the hook being installed and none touches a real working repo.
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// MSYS sh reads a drive-letter path but not a backslash one.
const HOOK = resolve(HERE, '../.githooks/reference-transaction').replace(
  /\\/g,
  '/',
);
const ZERO = '0'.repeat(40);

/**
 * Locates a POSIX shell: PATH first, then the copy Git for Windows ships
 * alongside its exec path (git is a prerequisite of the hook anyway).
 * @returns {string|null} Interpreter to spawn, or null if none was found.
 */
const findSh = () => {
  if (spawnSync('sh', ['-c', 'exit 0']).status === 0) return 'sh';
  try {
    const execPath = execFileSync('git', ['--exec-path'], {
      encoding: 'utf8',
    }).trim();
    const candidate = resolve(execPath, '../../../usr/bin/sh.exe');
    if (existsSync(candidate)) return candidate;
  } catch {
    /* fall through to the skip */
  }
  return null;
};
const SH = findSh();

describe(
  'reference-transaction hook',
  { skip: SH ? false : 'no POSIX sh available' },
  () => {
    let root;
    let repo;
    let virgin;
    let env;
    /** Commit OIDs: master sits at mid, old is its ancestor, ahead its child. */
    let old;
    let mid;
    let ahead;
    /** Sole commit of the fixture repo that has no master branch. */
    let orphan;

    /**
     * Runs git in a fixture repo with the hermetic environment.
     * @param {string} cwd - Repo to run in.
     * @param {...string} args - git arguments.
     * @returns {string} Trimmed stdout.
     */
    const git = (cwd, ...args) =>
      execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

    /**
     * Feeds a transaction to the hook.
     * @param {string[]} lines - "old new ref" records, one per ref update.
     * @param {string} [stage] - Transaction stage the hook is invoked for.
     * @param {string} [cwd] - Repo to run in.
     * @returns {{status: number, stderr: string}} Hook exit status and stderr.
     */
    const runHook = (lines, stage = 'prepared', cwd = repo) => {
      const run = spawnSync(SH, [HOOK, stage], {
        cwd,
        env,
        input: `${lines.join('\n')}\n`,
        encoding: 'utf8',
      });
      if (run.error) throw run.error;
      return { status: run.status, stderr: run.stderr };
    };

    const tokenPath = () => join(repo, '.git', 'hs-allow-nonff');
    const logPath = () => join(repo, '.git', 'hs-nonff.log');
    const writeToken = (value) => writeFileSync(tokenPath(), `${value}\n`);
    const readLog = () =>
      existsSync(logPath()) ? readFileSync(logPath(), 'utf8') : '';

    before(() => {
      root = mkdtempSync(join(tmpdir(), 'ref-txn-hook-'));
      env = {
        ...process.env,
        // Never read the operator's git config: a global core.hooksPath would
        // install this very hook into the fixtures.
        GIT_CONFIG_GLOBAL: join(root, 'absent-config'),
        GIT_CONFIG_SYSTEM: join(root, 'absent-config'),
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      };

      repo = join(root, 'repo');
      execFileSync('git', ['init', '-q', '-b', 'master', repo], { env });
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'old');
      old = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'mid');
      mid = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'ahead');
      ahead = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'update-ref', 'refs/heads/master', mid);
      git(repo, 'branch', 'fix/7', old);
      git(repo, 'branch', 'master-backup', old);

      virgin = join(root, 'virgin');
      execFileSync('git', ['init', '-q', '-b', 'main', virgin], { env });
      git(virgin, 'commit', '-q', '--allow-empty', '-m', 'only');
      orphan = git(virgin, 'rev-parse', 'HEAD');
    });

    beforeEach(() => {
      rmSync(tokenPath(), { force: true });
      rmSync(logPath(), { force: true });
    });

    after(() => {
      rmSync(root, { recursive: true, force: true });
    });

    test('refuses deletion of master', () => {
      const { status, stderr } = runHook([`${mid} ${ZERO} refs/heads/master`]);
      assert.equal(status, 1);
      assert.match(stderr, /REFUSED deletion of master/);
      assert.match(readLog(), new RegExp(`REFUSED deletion master ${mid}`));
    });

    test('a refused deletion leaves the authorization token unconsumed', () => {
      writeToken('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
      assert.ok(existsSync(tokenPath()));
    });

    test('the zero OID does not authorize a deletion', () => {
      writeToken(ZERO);
      const { status } = runHook([`${mid} ${ZERO} refs/heads/master`]);
      assert.equal(status, 1);
    });

    test('the doomed OID authorizes the deletion and is consumed', () => {
      writeToken(mid);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 0);
      assert.match(readLog(), new RegExp(`OVERRIDE deletion master ${mid}`));
      assert.equal(existsSync(tokenPath()), false);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('ANY authorizes a deletion', () => {
      writeToken('ANY');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 0);
      assert.equal(existsSync(tokenPath()), false);
    });

    test('a lowercase any does not authorize a deletion', () => {
      writeToken('any');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('refuses a rewind of master', () => {
      const { status, stderr } = runHook([`${ZERO} ${old} refs/heads/master`]);
      assert.equal(status, 1);
      assert.match(stderr, /REFUSED non-fast-forward update of master/);
      assert.match(readLog(), new RegExp(`REFUSED rewind master ${mid} -> ${old}`));
    });

    test('the target OID authorizes a rewind and is consumed', () => {
      writeToken(old);
      assert.equal(runHook([`${ZERO} ${old} refs/heads/master`]).status, 0);
      assert.match(readLog(), new RegExp(`OVERRIDE rewind master ${mid} -> ${old}`));
      assert.equal(existsSync(tokenPath()), false);
    });

    test('a token prefix of the target authorizes', () => {
      writeToken(old.slice(0, 10));
      assert.equal(runHook([`${ZERO} ${old} refs/heads/master`]).status, 0);
    });

    test('a token shorter than seven characters never authorizes', () => {
      writeToken(old.slice(0, 6));
      assert.equal(runHook([`${ZERO} ${old} refs/heads/master`]).status, 1);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('an empty token file never authorizes', () => {
      writeFileSync(tokenPath(), '\n');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('a token for another commit does not authorize', () => {
      writeToken(ahead);
      assert.equal(runHook([`${ZERO} ${old} refs/heads/master`]).status, 1);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('allows a fast-forward and logs nothing', () => {
      assert.equal(runHook([`${ZERO} ${ahead} refs/heads/master`]).status, 0);
      assert.equal(readLog(), '');
    });

    test('allows creation of master', () => {
      const { status } = runHook(
        [`${ZERO} ${orphan} refs/heads/master`],
        'prepared',
        virgin,
      );
      assert.equal(status, 0);
    });

    test('ignores every ref other than master', () => {
      const updates = [
        `${old} ${ZERO} refs/heads/fix/7`,
        `${mid} ${ZERO} refs/heads/master-backup`,
        `${mid} ${old} refs/heads/feature`,
        `${mid} ${ZERO} refs/remotes/origin/master`,
      ];
      for (const update of updates) assert.equal(runHook([update]).status, 0);
      assert.equal(readLog(), '');
    });

    test('governs only the prepared stage', () => {
      for (const stage of ['committed', 'aborted', '']) {
        const { status } = runHook([`${mid} ${ZERO} refs/heads/master`], stage);
        assert.equal(status, 0);
      }
      assert.equal(readLog(), '');
    });

    test('refuses a batch that deletes master alongside other refs', () => {
      const { status } = runHook([
        `${old} ${ZERO} refs/heads/fix/7`,
        `${mid} ${ZERO} refs/heads/master`,
      ]);
      assert.equal(status, 1);
    });
  },
);
