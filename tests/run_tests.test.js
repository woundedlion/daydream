import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectFailure, fixtureRepo, isolatedGitEnv } from './helpers/fixture_repo.js';
import { COVERAGE, lineCoverage } from '../scripts/run-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/run-tests.mjs');
const PATTERN = 'tests/*.test.js';
const EXEMPT = 'tests/uncovered-modules.json';
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

test('a passing suite that loads every source module passes', () => {
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

// The runner reports the floor on the spec stream rather than on stderr.
const failOutput = (...args) => {
  trackFixture();
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return `${error.stdout}${error.stderr}`;
  }
  return assert.fail('the command was expected to exit non-zero');
};

// Loading a module is not executing it: the roster gate passes on a module one
// import touches, and only the floor answers for the body that never ran.
test('a loaded module the suite never executes fails the line floor', () => {
  const branches = Array.from({ length: 40 },
    (_, index) => `  if (n === ${index}) return ${index};`).join('\n');
  writeFileSync(join(root, 'lib.mjs'),
    `export const value = 4;\nexport function unreached(n) {\n${branches}\n  return -1;\n}\n`);
  assert.match(failOutput(PATTERN), /line coverage does not meet threshold of 95%/);
});

// Every guard line runs, so the line floor holds while forty consequents never do.
test('a loaded module whose branches the suite never takes fails the branch floor', () => {
  const guards = Array.from({ length: 40 },
    (_, index) => `  if (n === ${index}) return ${index};`).join('\n');
  writeFileSync(join(root, 'lib.mjs'),
    `export const value = 4;\nexport function pick(n) {\n${guards}\n  return -1;\n}\npick(-1);\n`);
  const output = failOutput(PATTERN);
  assert.doesNotMatch(output, /line coverage does not meet/);
  assert.match(output, /branch coverage does not meet threshold of 90%/);
});

// Both floors and every exclusion are the gate; a new exclusion would ship
// green without this pin.
test('the coverage floors exclude only the code no unit test executes', () => {
  assert.deepEqual(COVERAGE, [
    '--experimental-test-coverage',
    '--test-coverage-lines=95',
    '--test-coverage-branches=90',
    '--test-coverage-exclude=tests/**',
  `--test-coverage-exclude=${fileURLToPath(new URL('../scripts/record-module-loads.mjs', import.meta.url))}`,
    '--test-coverage-exclude=generated/shader/**',
    '--test-coverage-exclude=generated/holosphere_wasm.js',
    '--test-coverage-exclude=scripts/browser-smoke.mjs',
    '--test-coverage-exclude=scripts/probe_harness.mjs',
    '--test-coverage-exclude=scripts/*-probe.mjs',
  ]);
});

test('a case that executes no assertion fails', () => {
  writeFileSync(join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test';\nimport '../lib.mjs';\ntest('empty', () => {});\n");
  assert.match(failOutput(PATTERN), /Every test case must execute an assertion/);
});

const dilutedCoverage = () => {
  writeFileSync(join(root, 'lib.mjs'),
    'export function unused() {\n  return 1;\n}\nexport const value = 4;\n');
  writeFileSync(join(root, 'padding.mjs'),
    Array.from({ length: 2000 }, (_, i) => `export const value${i} = ${i};`).join('\n'));
  writeFileSync(join(root, 'tests/sample.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import '../lib.mjs';\nimport '../padding.mjs';\ntest('works', () => assert.ok(true));\n");
};

test('aggregate coverage cannot hide an under-covered first-party file', () => {
  dilutedCoverage();
  assert.match(failOutput(PATTERN), /lib\.mjs line coverage .* below its 95% floor/);
});

test('reasoned coverage baselines still reject a per-file drop', () => {
  dilutedCoverage();
  writeFileSync(join(root, EXEMPT), JSON.stringify({
    'lib.mjs': { lines: 1, reason: 'Fixture exercises the measured baseline.' },
  }));
  assert.match(run(PATTERN), /source modules were loaded/);
  writeFileSync(join(root, EXEMPT), JSON.stringify({
    'lib.mjs': { lines: 90, reason: 'Fixture exercises the measured baseline.' },
  }));
  assert.match(failOutput(PATTERN), /lib\.mjs line coverage .* below its 90% floor/);
});

test('a coverage baseline cannot exempt an unloaded module', () => {
  writeFileSync(join(root, 'unused.mjs'), 'export const unused = true;\n');
  writeFileSync(join(root, EXEMPT), JSON.stringify({
    'unused.mjs': { lines: 80, reason: 'No longer measured.' },
  }));
  assert.match(failOutput(PATTERN), /coverage baseline but no measured file row/);
});

test('improved coverage makes a lower baseline redundant', () => {
  writeFileSync(join(root, EXEMPT), JSON.stringify({
    'lib.mjs': { lines: 80, reason: 'No longer needed.' },
  }));
  assert.match(failOutput(PATTERN), /covered after all/);
});

test('coverage parser preserves nested paths and rejects a missing table', () => {
  assert.deepEqual([...lineCoverage([
    '# start of coverage report',
    '# root.js | 99.00 | 90 | 90 |',
    '# tools | | | |',
    '#  nested | | | |',
    '#   library.js | 80.50 | 90 | 90 |',
    '#  helper.js | 98.00 | 90 | 90 |',
    '# next.js | 100.00 | 90 | 90 |',
    '# all files | 97.00 | 90 | 90 |',
    '# end of coverage report',
  ].join('\n'))], [
    ['root.js', 99], ['tools/nested/library.js', 80.5],
    ['tools/helper.js', 98], ['next.js', 100],
  ]);
  assert.throws(() => lineCoverage(''), /no file rows/);
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
  assert.match(fail(PATTERN), /uncovered-modules\.json is unreadable/);
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

test('aggregate coverage cannot hide a file with unexecuted branches', () => {
  dilutedCoverage();
  writeFileSync(join(root, 'lib.mjs'),
    'export const value = 4;\nexport function pick(n) { return n ? 1 : 2; }\npick(true);\n');
  writeFileSync(join(root, 'padding.mjs'),
    Array.from({ length: 30 }, (_, i) => `function f${i}() { return 1; } f${i}();`).join('\n'));
  assert.match(failOutput(PATTERN), /lib\.mjs branch coverage .* below its 90% floor/);
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
