import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchDir } from './helpers/fixture_repo.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const script = fileURLToPath(new URL('../scripts/extract-engine-bundle.py', import.meta.url));

/**
 * Writes an archive with a Python snippet and asserts extraction refuses it
 * without writing any output.
 * @param {import('node:test').TestContext} t - Test that owns the scratch dir.
 * @param {string[]} writer - Python arguments that write the archive named after them.
 * @param {RegExp} message - Expected refusal on stderr.
 * @param {string[]} [extra] - Arguments after the archive path.
 */
const assertUnsafeBundle = (t, writer, message, extra = []) => {
  const dir = scratchDir(t, 'bundle-path-');
  const archive = join(dir, 'bundle.zip');
  execFileSync(python, [...writer, archive, ...extra]);
  const result = spawnSync(python, [script, archive, join(dir, 'out')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
  assert.equal(existsSync(join(dir, 'out')), false);
};

for (const name of ['../escaped', '/absolute', 'C:/absolute', 'nested\\escaped', 'link']) {
  test(`bundle extraction rejects ${name} before writing any files`, (t) => {
    assertUnsafeBundle(t, ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("safe","ok"); i=zipfile.ZipInfo(sys.argv[2]); i.filename=sys.argv[2]; i.external_attr=(0o120777 << 16) if sys.argv[2]=="link" else 0; z.writestr(i,"outside"); z.close()'],
      /unsafe bundle entry/, [name]);
  });
}

test('bundle extraction retains valid nested files', (t) => {
  const dir = scratchDir(t, 'bundle-path-');
  const archive = join(dir, 'bundle.zip');
  execFileSync(python, ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("nested/file","ok"); z.close()', archive]);
  execFileSync(python, [script, archive, join(dir, 'out')]);
  assert.equal(readFileSync(join(dir, 'out/nested/file'), 'utf8'), 'ok');
});

test('bundle extraction rejects a NUL-truncated filename before writing', (t) => {
  assertUnsafeBundle(t, ['-c', 'import zipfile,sys,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p,"w"); z.writestr("safeXtail","data"); z.close(); p.write_bytes(p.read_bytes().replace(b"safeXtail", b"safe"+bytes([0])+b"tail"))'],
    /unsafe bundle entry/);
});

test('bundle extraction rejects duplicate names before writing any files', (t) => {
  assertUnsafeBundle(t, ['-W', 'ignore', '-c',
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("safe","first"); z.writestr("safe","second"); z.close()'],
    /unsafe bundle entry: 'safe'/);
});
