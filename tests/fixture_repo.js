//
// Harness shared by the cases that drive a script as a subprocess against a
// throwaway fixture repo under the OS temp dir, so no case touches the real
// working tree.
import { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * Locates a POSIX shell: PATH first, then the copy Git for Windows ships
 * alongside its exec path (git is a prerequisite of every hook anyway).
 * @returns {string|null} Interpreter to spawn, or null if none was found.
 */
export const findSh = () => {
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

/** Returns an environment that cannot redirect fixture commands into the caller's repository. */
export const isolatedGitEnv = (base = process.env) => {
  const env = { ...base };
  for (const name of LOCAL_GIT_ENV) delete env[name];
  return env;
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
 * Runs a command expecting a non-zero exit.
 * @param {string} file - Executable to run.
 * @param {string[]} args - Arguments to pass it.
 * @param {Object} [options] - execFileSync options; stdio is pinned so the
 *   command's stderr is captured rather than inherited.
 * @returns {string} The command's stderr.
 */
export const expectFailure = (file, args, options = {}) => {
  try {
    execFileSync(file, args, {
      ...options,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    return String(e.stderr);
  }
  assert.fail('the command was expected to exit non-zero');
};
