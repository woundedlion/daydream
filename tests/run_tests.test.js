import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectFailure, fixtureRepo, isolatedGitEnv } from './helpers/fixture_repo.js';
import { BRANCH_FLOOR, COVERAGE, LINE_FLOOR, totalCoverage } from '../scripts/run-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/run-tests.mjs');
const PATTERN = 'tests/*.test.js';
const EXEMPT = 'tests/unloaded-modules.json';
const env = isolatedGitEnv(process.env);
delete env.NODE_TEST_CONTEXT;

const trackFixture = () => execFileSync('git', ['add', '-A'], { cwd: root, env });

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
  execFileSync('git', ['init', '--quiet'], { cwd: root, env });
};
const root = fixtureRepo('run-tests-', buildRoot);
const run = (...args) => {
  trackFixture();
  return String(execFileSync(
    process.execPath, [SCRIPT, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  ));
};
const fail = (...args) => {
  trackFixture();
  return expectFailure(process.execPath, [SCRIPT, ...args], { cwd: root, env });
};

const failOutput = (...args) => {
  trackFixture();
  return expectFailure(process.execPath, [SCRIPT, ...args], { cwd: root, env, captureStdout: true });
};

test('a passing suite that loads every source module passes', () => {
  assert.match(run(PATTERN), /source modules were loaded by tests/);
});

test('the engine checkout is excluded without hiding application engine modules', () => {
  mkdirSync(join(root, 'engine'), { recursive: true });
  mkdirSync(join(root, 'src/engine'), { recursive: true });
  writeFileSync(join(root, 'engine/runtime.mjs'), 'export const runtime = true;\n');
  writeFileSync(join(root, 'src/engine/host.mjs'), 'export const host = true;\n');
  const failure = fail(PATTERN);
  assert.match(failure, /src\/engine\/host\.mjs/);
  assert.doesNotMatch(failure, /engine\/runtime\.mjs/);
  appendFileSync(join(root, 'tests/sample.test.js'), "import '../src/engine/host.mjs';\n");
  assert.match(run(PATTERN), /source modules were loaded by tests/);
});

test('recursive patterns require the live discovery canary', () => {
  assert.match(fail('tests/**/*.test.js'), /recursive discovery canary did not run/);
  mkdirSync(join(root, 'tests/discovery'), { recursive: true });
  writeFileSync(join(root, 'tests/discovery/nested.test.js'),
    "import { test } from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "test('recursive test discovery reaches nested Node modules', () => assert.match(import.meta.url, /discovery/));\n");
  assert.match(run('tests/**/*.test.js'), /source modules were loaded by tests/);
});

test('an unmatched test pattern cannot report success', () => {
  assert.match(fail('tests/no-such-test-*.js'), /no tests executed|Could not find/);
});

test('an untracked source module is outside the coverage roster', () => {
  trackFixture();
  writeFileSync(join(root, 'scratch.mjs'), 'export const scratch = true;\n');
  assert.match(
    String(execFileSync(
      process.execPath,
      [SCRIPT, PATTERN],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )),
    /source modules were loaded by tests/,
  );
});

test('a failing test fails the run', () => {
  writeFileSync(
    join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n",
  );
  assert.match(failOutput(PATTERN), /boom/);
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

test('an exemption whose reason is not a non-empty string fails', () => {
  writeFileSync(join(root, 'browser.mjs'), 'document.body.textContent = "ready";\n');
  for (const reason of ['', '  ', { reason: 'Not a string.' }]) {
    writeFileSync(join(root, EXEMPT), JSON.stringify({ 'browser.mjs': reason }));
    assert.match(fail(PATTERN), /must explain why/);
  }
});

test('a stale exemption fails', () => {
  writeFileSync(join(root, EXEMPT), JSON.stringify({ 'gone.mjs': 'Old module.' }));
  assert.match(fail(PATTERN), /name no source module[\s\S]*gone\.mjs/);
});

test('a redundant exemption fails', () => {
  writeFileSync(join(root, EXEMPT), JSON.stringify({ 'lib.mjs': 'No longer true.' }));
  assert.match(fail(PATTERN), /loaded by a test after all[\s\S]*lib\.mjs/);
});

test('no test pattern fails', () => {
  assert.match(fail('--experimental-test-module-mocks'), /pass the test file patterns/);
});

// Loading a module is not executing it: the roster gate passes on a module one
// import touches, and only the floor answers for the body that never ran.
test('loaded code the suite never executes fails the overall line floor', () => {
  const branches = Array.from({ length: 40 },
    (_, index) => `  if (n === ${index}) return ${index};`).join('\n');
  writeFileSync(join(root, 'lib.mjs'),
    `export const value = 4;\nexport function unreached(n) {\n${branches}\n  return -1;\n}\n`);
  assert.match(failOutput(PATTERN), /overall line coverage .* below the 92% floor/);
});

// Every guard line runs, so the line floor holds while forty consequents never do.
test('branches the suite never takes fail the overall branch floor', () => {
  const guards = Array.from({ length: 40 },
    (_, index) => `  if (n === ${index}) return ${index};`).join('\n');
  writeFileSync(join(root, 'lib.mjs'),
    `export const value = 4;\nexport function pick(n) {\n${guards}\n  return -1;\n}\npick(-1);\n`);
  const output = failOutput(PATTERN);
  assert.doesNotMatch(output, /line coverage .* below/);
  assert.match(output, /overall branch coverage .* below the 93% floor/);
});

test('the overall coverage floors are 92% of lines and 93% of branches', () => {
  assert.equal(LINE_FLOOR, 92);
  assert.equal(BRANCH_FLOOR, 93);
});

const REPO = resolve(HERE, '..');
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

const importsUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : importsUnder(path);
  if (!/\.m?js$/.test(entry.name)) return [];
  return [...readFileSync(path, 'utf8').matchAll(IMPORT)]
    .map((match) => relative(REPO, resolve(dirname(path), match[1])).replaceAll('\\', '/'));
});

test('coverage excludes no tracked module a unit test imports', () => {
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0').filter(Boolean));
  const imported = [...new Set(importsUnder(join(REPO, 'tests')))]
    .filter((path) => tracked.has(path) && !path.startsWith('tests/'));
  assert.ok(imported.includes('scripts/run-tests.mjs'), 'the import scan missed a known import');
  const globs = COVERAGE
    .filter((flag) => flag.startsWith('--test-coverage-exclude='))
    .map((flag) => flag.slice('--test-coverage-exclude='.length))
    .map((glob) => (isAbsolute(glob) ? relative(REPO, glob) : glob).replaceAll('\\', '/'));
  assert.deepEqual(imported.flatMap((path) => globs
    .filter((glob) => matchesGlob(path, glob))
    .map((glob) => `${path} matches ${glob}`)), []);
});

test('a case that executes no assertion fails', () => {
  writeFileSync(join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test';\nimport '../lib.mjs';\ntest('empty', () => {});\n");
  assert.match(failOutput(PATTERN), /Every test case must execute an assertion/);
});

test('coverage parser reads the totals row and rejects a missing one', () => {
  assert.deepEqual(totalCoverage([
    '# start of coverage report',
    '# root.js | 99.00 | 90.00 | 90 |',
    '# all files | 97.25 | 88.50 | 90 |',
    '# end of coverage report',
  ].join('\n')), { lines: 97.25, branches: 88.5 });
  assert.throws(() => totalCoverage(''), /no totals row/);
});

test('CI rejects skipped cases even when another test passes', () => {
  writeFileSync(join(root, 'tests/skipped.test.js'),
    "import { test } from 'node:test';\ntest.skip('skipped', () => {});\n");
  trackFixture();
  assert.match(expectFailure(process.execPath, [SCRIPT, PATTERN], {
    cwd: root, env: { ...env, CI: 'true' },
  }), /CI must execute every test without skips/);
});

test('a missing git executable rejects source enumeration', () => {
  trackFixture();
  const withoutPath = Object.fromEntries(Object.entries(env)
    .filter(([key]) => key.toLowerCase() !== 'path'));
  withoutPath.PATH = join(root, 'no-executables');
  assert.match(expectFailure(process.execPath, [SCRIPT, PATTERN], {
    cwd: root, env: withoutPath,
  }), /git ls-files failed while enumerating source modules/);
});

test('malformed exemption JSON fails instead of waiving the roster', () => {
  writeFileSync(join(root, EXEMPT), '{broken');
  assert.match(fail(PATTERN), /unloaded-modules\.json is unreadable/);
});

test('assertion accounting preserves callback-style asynchronous tests', () => {
  writeFileSync(join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import '../lib.mjs';\n"
    + "test('callback', (t, done) => { setImmediate(() => { assert.equal(2+2, 4); done(); }); });\n");
  assert.match(run(PATTERN), /source modules were loaded by tests/);
});

test('callback-style tests still require an assertion before done', () => {
  writeFileSync(join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test'; import '../lib.mjs';\n"
    + "test('empty callback', (t, done) => { setImmediate(done); });\n");
  assert.match(failOutput(PATTERN), /Every test case must execute an assertion/);
});

test('CI rejects a failing todo test', () => {
  writeFileSync(join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import '../lib.mjs';\n"
    + "test('todo', { todo: true }, () => assert.fail('regression'));\n");
  trackFixture();
  assert.match(expectFailure(process.execPath, [SCRIPT, PATTERN], {
    cwd: root, env: { ...env, CI: 'true' },
  }), /CI must execute every test without todos/);
});
