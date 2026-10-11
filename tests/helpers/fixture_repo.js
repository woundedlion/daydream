// Harness shared by the cases that drive a script as a subprocess against a
// throwaway fixture repo under the OS temp dir, so no case touches the real
// working tree.
import { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
];

/**
 * Locates a shell on PATH or in Git for Windows.
 * @param {string} name - Interpreter basename.
 * @returns {string|null} Interpreter to spawn, or null when unavailable.
 */
const findShell = (name) => {
  if (spawnSync(name, ['-c', 'exit 0']).status === 0) return name;
  try {
    const execPath = execFileSync('git', ['--exec-path'], {
      encoding: 'utf8',
    }).trim();
    const candidate = resolve(execPath, `../../../usr/bin/${name}.exe`);
    if (existsSync(candidate)) return candidate;
  } catch {
    /* fall through to the skip */
  }
  return null;
};

/** @returns {string|null} POSIX shell interpreter. */
export const findSh = () => findShell('sh');
/** @returns {string|null} Bash interpreter. */
export const findBash = () => findShell('bash');

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../.githooks');
const MISSING_SH = 'no POSIX shell available';

/**
 * Locates a repository git hook and the POSIX shell that runs it. Without a
 * shell its cases skip, unless DAYDREAM_HOOK_SH_REQUIRED is set.
 * @param {string} name - Hook basename under .githooks.
 * @returns {{hook: string, sh: string|null, skip: string|false,
 *   missing: string}} The hook path with forward slashes (MSYS sh does not
 *   read a backslash path), the shell, the test skip option, and the
 *   missing-shell message.
 */
export const hookUnderTest = (name) => {
  const sh = findSh();
  return {
    hook: resolve(HOOKS_DIR, name).replace(/\\/g, '/'),
    sh,
    skip: sh || process.env.DAYDREAM_HOOK_SH_REQUIRED ? false : MISSING_SH,
    missing: MISSING_SH,
  };
};

// A config path that never exists, so no operator setting reaches a fixture: a
// global core.excludesFile or core.autocrlf would steer ls-files and add, and a
// global core.hooksPath would install the caller's hooks into the fixtures.
const ABSENT_CONFIG = join(tmpdir(), 'daydream-absent-gitconfig', 'absent');

/**
 * Returns an environment that cannot redirect fixture commands into the
 * caller's repository, read the operator's git config, or depend on an
 * identity the operator happens to have configured.
 * @param {Object} [base] - Environment to derive from.
 * @returns {Object} The isolated environment.
 */
export const isolatedGitEnv = (base = process.env) => {
  const env = { ...base };
  for (const name of LOCAL_GIT_ENV) delete env[name];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: ABSENT_CONFIG,
    GIT_CONFIG_SYSTEM: ABSENT_CONFIG,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
};

/**
 * Makes a fixture directory, rebuilt before each case and removed after the
 * suite.
 * @param {string} prefix - Name prefix for the temp directory.
 * @param {() => void} build - Recreates the fixture contents.
 * @returns {string} The fixture root.
 */
export const fixtureRepo = (prefix, build) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  beforeEach(build);
  after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

/**
 * Writes a file under `base`, creating its parent directories.
 * @param {string} base - Root directory.
 * @param {string} path - Path relative to `base`.
 * @param {string|Uint8Array} contents - File contents.
 * @returns {void}
 */
export const writeFileAt = (base, path, contents) => {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), contents);
};

/**
 * Writes an engine bundle: each file plus the holosphere_engine.sha256
 * manifest listing its checksum.
 * @param {string} bundle - Bundle directory.
 * @param {Object<string, string>} files - Contents by bundle-relative path.
 * @returns {void}
 */
export const writeEngineBundle = (bundle, files) => {
  const manifest = Object.entries(files).map(([path, contents]) => {
    writeFileAt(bundle, path, contents);
    return `${createHash('sha256').update(contents).digest('hex')}  ./${path}`;
  }).join('\n');
  writeFileAt(bundle, 'holosphere_engine.sha256', manifest + '\n');
};

/**
 * Runs a command expecting a non-zero exit.
 * @param {string} file - Executable to run.
 * @param {string[]} args - Arguments to pass it.
 * @param {Object} [options] - execFileSync options; stdio is pinned so the
 *   command's stderr is captured rather than inherited.
 * @param {boolean} [options.captureStdout=false] - Include stdout before stderr.
 * @returns {string} The command's stderr, preceded by stdout when requested.
 */
export const expectFailure = (file, args, { captureStdout = false, ...options } = {}) => {
  try {
    execFileSync(file, args, {
      ...options,
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });
  } catch (e) {
    return captureStdout ? `${e.stdout}${e.stderr}` : String(e.stderr);
  }
  assert.fail('the command was expected to exit non-zero');
};

/**
 * Makes a scratch directory under the OS temp dir, removed when the test ends.
 * @param {import('node:test').TestContext} t - Test that owns the directory.
 * @param {string} prefix - Name prefix for the temp directory.
 * @returns {string} The scratch directory.
 */
export const scratchDir = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
