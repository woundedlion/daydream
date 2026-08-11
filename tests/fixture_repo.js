//
// Harness shared by the cases that drive a script as a subprocess against a
// throwaway fixture repo under the OS temp dir, so no case touches the real
// working tree.
import { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
