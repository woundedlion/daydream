// .githooks/reference-transaction guards refs/heads/master, driven as
// `sh <hook> <stage>` with a synthesized transaction on stdin against throwaway
// fixture repos.
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hookUnderTest, isolatedGitEnv } from './helpers/fixture_repo.js';

const {
  hook: HOOK, sh: SH, skip: SKIP, missing: MISSING,
} = hookUnderTest('reference-transaction');
const ZERO = '0'.repeat(40);

describe(
  'reference-transaction hook',
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
      assert.ok(SH, MISSING);
      // A file, not a pipe: the hook exits unread for non-prepared stages,
      // and a piped write would race that exit to EPIPE.
      const inputPath = join(root, 'hook-input');
      writeFileSync(inputPath, `${lines.join('\n')}\n`);
      const input = openSync(inputPath, 'r');
      let run;
      try {
        run = spawnSync(SH, [HOOK, stage], {
          cwd,
          env,
          stdio: [input, 'pipe', 'pipe'],
          encoding: 'utf8',
        });
      } finally {
        closeSync(input);
      }
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
      env = isolatedGitEnv();

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
      rmSync(join(repo, '.git', 'packed-refs'), { force: true });
      rmSync(join(repo, '.git', 'packed-refs.lock'), { force: true });
    });

    after(() => {
      rmSync(root, { recursive: true, force: true });
    });

    test('malformed records fail closed and append an audit entry', { skip: SKIP }, () => {
      const result = runHook([`${mid} refs/heads/master`]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /malformed reference transaction/);
      assert.match(readLog(), /REFUSED malformed reference transaction/);
    });

    test('refuses deletion of master', { skip: SKIP }, () => {
      const { status, stderr } = runHook([`${mid} ${ZERO} refs/heads/master`]);
      assert.equal(status, 1);
      assert.match(stderr, /REFUSED deletion of master/);
      assert.match(readLog(), new RegExp(`REFUSED deletion master ${mid}`));
    });

    test('allows pruning a master already preserved in packed refs', { skip: SKIP }, () => {
      writeFileSync(join(repo, '.git', 'packed-refs'), `${mid} refs/heads/master\n`);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 0);
      assert.equal(readLog(), '');
    });

    test('refuses deletion while packed refs are locked or do not preserve master', { skip: SKIP }, () => {
      writeFileSync(join(repo, '.git', 'packed-refs'), `${mid} refs/heads/master\n`);
      writeFileSync(join(repo, '.git', 'packed-refs.lock'), '');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
      rmSync(join(repo, '.git', 'packed-refs.lock'));
      writeFileSync(join(repo, '.git', 'packed-refs'), `${old} refs/heads/master\n`);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('a refused deletion leaves the authorization token unconsumed', { skip: SKIP }, () => {
      writeToken('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
      assert.ok(existsSync(tokenPath()));
    });

    test('the zero OID does not authorize a deletion', { skip: SKIP }, () => {
      writeToken(ZERO);
      const { status } = runHook([`${mid} ${ZERO} refs/heads/master`]);
      assert.equal(status, 1);
    });

    test('the doomed OID authorizes the deletion and is consumed', { skip: SKIP }, () => {
      writeToken(mid);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 0);
      assert.match(readLog(), new RegExp(`OVERRIDE deletion master ${mid}`));
      assert.equal(existsSync(tokenPath()), false);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('ANY authorizes a deletion', { skip: SKIP }, () => {
      writeToken('ANY');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 0);
      assert.equal(existsSync(tokenPath()), false);
    });

    test('a lowercase any does not authorize a deletion', { skip: SKIP }, () => {
      writeToken('any');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('refuses a rewind of master', { skip: SKIP }, () => {
      const { status, stderr } = runHook([`${ZERO} ${old} refs/heads/master`]);
      assert.equal(status, 1);
      assert.match(stderr, /REFUSED non-fast-forward update of master/);
      assert.match(readLog(), new RegExp(`REFUSED rewind master ${mid} -> ${old}`));
    });

    test('refusals from git -C name an absolute token path', { skip: SKIP }, () => {
      const result = spawnSync('git', ['-C', repo, '-c', `core.hooksPath=${dirname(HOOK)}`,
        'update-ref', 'refs/heads/master', old], {cwd: root, env, encoding: 'utf8'});
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.replaceAll('\\', '/').includes(
        `git rev-parse ${old} > "${tokenPath().replaceAll('\\', '/')}"`));
      assert.equal(git(repo, 'rev-parse', 'refs/heads/master'), mid);
    });

    test('the target OID authorizes a rewind and is consumed', { skip: SKIP }, () => {
      writeToken(old);
      assert.equal(runHook([`${ZERO} ${old} refs/heads/master`]).status, 0);
      assert.match(readLog(), new RegExp(`OVERRIDE rewind master ${mid} -> ${old}`));
      assert.equal(existsSync(tokenPath()), false);
    });

    test('a linked worktree consumes the common-directory override token', { skip: SKIP }, () => {
      const linked = join(root, 'linked');
      execFileSync('git', ['worktree', 'add', '--detach', linked, mid],
        { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' });
      writeToken(old);
      assert.equal(runHook([`${mid} ${old} refs/heads/master`], 'prepared', linked).status, 0);
      assert.equal(existsSync(tokenPath()), false);
      assert.match(readLog(), new RegExp(`OVERRIDE rewind master ${mid} -> ${old}`));
    });

    test('a token prefix of the target authorizes', { skip: SKIP }, () => {
      writeToken(old.slice(0, 10));
      assert.equal(runHook([`${ZERO} ${old} refs/heads/master`]).status, 0);
    });

    test('a token shorter than seven characters never authorizes', { skip: SKIP }, () => {
      writeToken(old.slice(0, 6));
      assert.equal(runHook([`${ZERO} ${old} refs/heads/master`]).status, 1);
      writeToken(mid.slice(0, 6));
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('an empty token file never authorizes', { skip: SKIP }, () => {
      writeFileSync(tokenPath(), '\n');
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('a token for another commit does not authorize', { skip: SKIP }, () => {
      writeToken(ahead);
      assert.equal(runHook([`${ZERO} ${old} refs/heads/master`]).status, 1);
      assert.equal(runHook([`${mid} ${ZERO} refs/heads/master`]).status, 1);
    });

    test('allows a fast-forward and logs nothing', { skip: SKIP }, () => {
      assert.equal(runHook([`${ZERO} ${ahead} refs/heads/master`]).status, 0);
      assert.equal(readLog(), '');
    });

    test('allows creation of master', { skip: SKIP }, () => {
      const { status } = runHook(
        [`${ZERO} ${orphan} refs/heads/master`],
        'prepared',
        virgin,
      );
      assert.equal(status, 0);
    });

    test('ignores every ref other than master', { skip: SKIP }, () => {
      const updates = [
        `${old} ${ZERO} refs/heads/fix/7`,
        `${mid} ${ZERO} refs/heads/master-backup`,
        `${mid} ${old} refs/heads/feature`,
        `${mid} ${ZERO} refs/remotes/origin/master`,
      ];
      for (const update of updates) assert.equal(runHook([update]).status, 0);
      assert.equal(readLog(), '');
    });

    test('governs only the prepared stage', { skip: SKIP }, () => {
      for (const stage of ['committed', 'aborted', '']) {
        const { status } = runHook([`${mid} ${ZERO} refs/heads/master`], stage);
        assert.equal(status, 0);
      }
      assert.equal(readLog(), '');
    });

    test('refuses a batch that deletes master alongside other refs', { skip: SKIP }, () => {
      const { status } = runHook([
        `${old} ${ZERO} refs/heads/fix/7`,
        `${mid} ${ZERO} refs/heads/master`,
      ]);
      assert.equal(status, 1);
    });
  },
);
