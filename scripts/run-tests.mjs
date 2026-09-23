// Run the requested node:test suite, then verify that every first-party source
// module was loaded by a test or has a reasoned exemption.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXEMPT_PATH = 'tests/uncovered-modules.json';
const LOAD_RECORDER = new URL('./record-module-loads.mjs', import.meta.url).href;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.worktrees', 'vendor', 'three.js', 'engine',
]);

// Execution floors over the modules the roster gate proves were loaded, set
// under a measurement of this suite. The exclusions are the code no unit test
// executes: the suites themselves, the engine's installed shader mirror, the
// generated Emscripten glue, and the scripts a browser runs.
// tests/run_tests.test.js pins the list.
export const COVERAGE = [
  '--experimental-test-coverage',
  '--test-coverage-lines=95',
  '--test-coverage-branches=90',
  '--test-coverage-exclude=tests/**',
  `--test-coverage-exclude=${fileURLToPath(new URL('./record-module-loads.mjs', import.meta.url))}`,
  '--test-coverage-exclude=shader/**',
  '--test-coverage-exclude=holosphere_wasm.js',
  '--test-coverage-exclude=scripts/browser-smoke.mjs',
  '--test-coverage-exclude=scripts/probe_harness.mjs',
  '--test-coverage-exclude=scripts/*-probe.mjs',
];

const main = () => {
  const args = process.argv.slice(2);
  const patterns = args.filter((arg) => !arg.startsWith('-'));
  if (patterns.length === 0) {
    console.error(
      'run-tests: pass the test file patterns to run, e.g. ' +
        '`node scripts/run-tests.mjs "tests/**/*.test.js"`.',
    );
    process.exit(1);
  }

  const keyOf = (file) => relative(process.cwd(), file).replaceAll('\\', '/');
  const testDirs = new Set(
    patterns
      .map((pattern) => pattern.split('/'))
      .map((parts) => parts.slice(0, parts.findIndex((part) => part.includes('*'))))
      .filter((parts) => parts.length > 0)
      .map((parts) => parts.join('/')),
  );

  const scratch = mkdtempSync(join(tmpdir(), 'daydream-run-tests-'));
  const loadsDir = join(scratch, 'loads');
  const reportPath = join(scratch, 'results.tap');
  const loaded = new Set();
  let status;
  try {
    mkdirSync(loadsDir);
    const run = spawnSync(process.execPath, ['--test',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=tap', `--test-reporter-destination=${reportPath}`,
      ...COVERAGE, ...args], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${LOAD_RECORDER}`,
        DAYDREAM_MODULE_LOADS: loadsDir,
      },
    });
    if (run.error) throw run.error;
    status = run.status ?? 1;
    if (status === 0 && !/^# tests [1-9]\d*\s*$/m.test(readFileSync(reportPath, 'utf8'))) {
      console.error('run-tests: no tests executed; refusing an empty green run.');
      status = 1;
    }
    if (status === 0 && process.env.CI
        && !/^# skipped 0\s*$/m.test(readFileSync(reportPath, 'utf8'))) {
      console.error('run-tests: CI must execute every test without skips.');
      status = 1;
    }
    for (const entry of readdirSync(loadsDir)) {
      for (const url of JSON.parse(readFileSync(join(loadsDir, entry), 'utf8'))) {
        const key = keyOf(fileURLToPath(url.split(/[?#]/)[0]));
        if (!key.startsWith('..')) loaded.add(key);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (status !== 0) process.exit(status);

  let tracked;
  try {
    tracked = execFileSync(
      'git',
      ['ls-files', '-z', '--', ':(glob)**/*.js', ':(glob)**/*.mjs'],
      { encoding: 'utf8' },
    );
  } catch {
    console.error('run-tests: git ls-files failed while enumerating source modules.');
    process.exit(1);
  }
  const roster = tracked.split('\0')
    .filter(Boolean)
    .filter((path) => !path.split('/').some((part) => SKIP_DIRS.has(part)))
    .filter((path) => ![...testDirs].some((dir) => path === dir || path.startsWith(`${dir}/`)))
    .sort();

  let exempt = {};
  if (existsSync(EXEMPT_PATH)) {
    try {
      exempt = JSON.parse(readFileSync(EXEMPT_PATH, 'utf8'));
    } catch (error) {
      console.error(`run-tests: ${EXEMPT_PATH} is unreadable (${error.code ?? error.message}).`);
      process.exit(1);
    }
  }
  const unreasoned = Object.entries(exempt)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
    .map(([file]) => file)
    .sort();
  const uncovered = roster.filter((file) => !loaded.has(file) && !(file in exempt));
  const stale = Object.keys(exempt).filter((file) => !roster.includes(file)).sort();
  const redundant = Object.keys(exempt).filter((file) => loaded.has(file)).sort();
  const failures = [];
  const block = (heading, files, remedy) =>
    `run-tests: ${heading}:\n${files.map((file) => `  ${file}`).join('\n')}\n${remedy}`;
  if (unreasoned.length > 0) failures.push(block(
    `every ${EXEMPT_PATH} entry must explain why the module cannot be covered`,
    unreasoned,
    'Add a concrete reason or delete the exemption.',
  ));
  if (uncovered.length > 0) failures.push(block(
    'no test loaded these source modules',
    uncovered,
    `Write a test that imports each, or record why it cannot be covered in ${EXEMPT_PATH}.`,
  ));
  if (stale.length > 0) failures.push(block(
    `these ${EXEMPT_PATH} entries name no source module`, stale, 'Delete the stale exemptions.',
  ));
  if (redundant.length > 0) failures.push(block(
    `these ${EXEMPT_PATH} entries are covered after all`, redundant, 'Delete the redundant exemptions.',
  ));
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }

  console.log(
    `run-tests: ${roster.length - Object.keys(exempt).length} of ${roster.length} ` +
      `source modules were loaded by tests; the rest have reasoned exemptions in ${EXEMPT_PATH}.`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
