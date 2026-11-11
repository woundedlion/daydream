import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {isolatedGitEnv, scratchDir, writeFileAt} from './helpers/fixture_repo.js';

for (const location of ['home', 'xdg']) {
  test(`fixture git ignores operator default ignore and attributes files under ${location}`, (t) => {
    const root = scratchDir(t, 'daydream-git-defaults-');
    const home = join(root, 'home');
    const xdg = join(root, 'operator-xdg');
    const operator = location === 'home' ? join(home, '.config') : xdg;
    writeFileAt(operator, 'git/ignore', 'probe.txt\n');
    writeFileAt(operator, 'git/attributes', 'probe.txt marker=operator\n');
    writeFileAt(root, 'probe.txt', 'fixture');
    const env = isolatedGitEnv({...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: location === 'xdg' ? xdg : undefined});
    execFileSync('git', ['-C', root, 'init', '-q'], {env});
    const contaminated = {...env, XDG_CONFIG_HOME: location === 'xdg' ? xdg : undefined};
    const ignore = (settings) => spawnSync('git', ['-C', root, 'check-ignore', '--no-index', 'probe.txt'],
      {env: settings, encoding: 'utf8'});
    const attributes = (settings) => execFileSync('git', ['-C', root, 'check-attr', 'marker', '--', 'probe.txt'],
      {env: settings, encoding: 'utf8'}).trim();
    assert.equal(ignore(contaminated).status, 0, 'the operator ignore fixture is active without isolation');
    assert.equal(attributes(contaminated), 'probe.txt: marker: operator');
    assert.equal(ignore(env).status, 1);
    assert.equal(attributes(env), 'probe.txt: marker: unspecified');
  });
}

test('fixture git ignores the operator template directory', (t) => {
  const root = scratchDir(t, 'daydream-git-template-');
  const fixture = join(root, 'fixture');
  const template = join(root, 'template');
  writeFileAt(template, 'hooks/pre-commit', '#!/bin/sh\nexit 1\n');
  const env = isolatedGitEnv({...process.env, GIT_TEMPLATE_DIR: template});
  execFileSync('git', ['-C', root, 'init', '-q', fixture], {env});
  assert.equal(existsSync(join(fixture, '.git', 'hooks', 'pre-commit')), false);
});
