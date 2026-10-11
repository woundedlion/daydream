import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchDir } from './helpers/fixture_repo.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const script = fileURLToPath(new URL('../scripts/extract-engine-bundle.py', import.meta.url));
for (const name of ['../escaped', '/absolute', 'C:/absolute', 'nested\\escaped', 'link']) {
  test(`bundle extraction rejects ${name} before writing any files`, (t) => {
    const dir = scratchDir(t, 'bundle-path-');
    const archive = join(dir, 'bundle.zip');
    execFileSync(python, ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("safe","ok"); i=zipfile.ZipInfo(sys.argv[2]); i.filename=sys.argv[2]; i.external_attr=(0o120777 << 16) if sys.argv[2]=="link" else 0; z.writestr(i,"outside"); z.close()', archive, name]);
    const result = spawnSync(python, [script, archive, join(dir, 'out')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe bundle entry/);
    assert.equal(existsSync(join(dir, 'out')), false);
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
  const dir = scratchDir(t, 'bundle-path-');
  const archive = join(dir, 'bundle.zip');
  execFileSync(python, ['-c', 'import zipfile,sys,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p,"w"); z.writestr("safeXtail","data"); z.close(); p.write_bytes(p.read_bytes().replace(b"safeXtail", b"safe"+bytes([0])+b"tail"))', archive]);
  const result = spawnSync(python, [script, archive, join(dir, 'out')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe bundle entry/);
  assert.equal(existsSync(join(dir, 'out')), false);
});

test('bundle extraction rejects duplicate names before writing any files', (t) => {
  const dir = scratchDir(t, 'bundle-duplicate-');
  const archive = join(dir, 'bundle.zip');
  execFileSync(python, ['-W', 'ignore', '-c',
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("safe","first"); z.writestr("safe","second"); z.close()',
    archive]);
  const result = spawnSync(python, [script, archive, join(dir, 'out')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe bundle entry: 'safe'/);
  assert.equal(existsSync(join(dir, 'out')), false);
});
