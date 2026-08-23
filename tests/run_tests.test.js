import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectFailure, fixtureRepo } from './fixture_repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/run-tests.mjs');
const PATTERN = 'tests/*.test.js';
const EXEMPT = 'tests/uncovered-modules.json';
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

const buildRoot = () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, EXEMPT), '{}\n');
  writeFileSync(
    join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport '../lib.mjs';\ntest('works', () => assert.equal(2 + 2, 4));\n",
  );
  writeFileSync(join(root, 'lib.mjs'), 'export const value = 4;\n');
};
const root = fixtureRepo('run-tests-', buildRoot);
const run = (...args) => String(execFileSync(
  process.execPath, [SCRIPT, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
));
const fail = (...args) => expectFailure(
  process.execPath, [SCRIPT, ...args], { cwd: root, env },
);

test('a passing suite that loads every source module passes', () => {
  assert.match(run(PATTERN), /source modules were loaded by tests/);
});

test('a failing test fails the run', () => {
  writeFileSync(
    join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n",
  );
  fail(PATTERN);
});

test('a source module no test loads fails', () => {
  writeFileSync(join(root, 'unused.mjs'), 'export const unused = true;\n');
  assert.match(fail(PATTERN), /no test loaded these source modules[\s\S]*unused\.mjs/);
});

test('a reasoned exemption covers an unloadable module', () => {
  writeFileSync(join(root, 'browser.mjs'), 'document.body.textContent = "ready";\n');
  writeFileSync(
    join(root, EXEMPT),
    JSON.stringify({ 'browser.mjs': 'Requires a browser DOM.' }),
  );
  assert.match(run(PATTERN), /reasoned exemptions/);
});

test('an exemption with no reason fails', () => {
  writeFileSync(join(root, 'browser.mjs'), 'document.body.textContent = "ready";\n');
  writeFileSync(join(root, EXEMPT), JSON.stringify({ 'browser.mjs': '' }));
  assert.match(fail(PATTERN), /must explain why/);
});

test('a stale exemption fails', () => {
  writeFileSync(join(root, EXEMPT), JSON.stringify({ 'gone.mjs': 'Old module.' }));
  assert.match(fail(PATTERN), /name no source module[\s\S]*gone\.mjs/);
});

test('a redundant exemption fails', () => {
  writeFileSync(join(root, EXEMPT), JSON.stringify({ 'lib.mjs': 'No longer true.' }));
  assert.match(fail(PATTERN), /covered after all[\s\S]*lib\.mjs/);
});

test('no test pattern fails', () => {
  assert.match(fail('--experimental-test-module-mocks'), /pass the test file patterns/);
});
