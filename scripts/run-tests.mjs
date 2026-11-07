// Run the requested node:test suite, then verify that every first-party source
// module was loaded by a test or has a reasoned exemption.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXEMPT_PATH = 'tests/unloaded-modules.json';
const LOAD_RECORDER = new URL('./record-module-loads.mjs', import.meta.url).href;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.worktrees', 'vendor', 'three.js', 'engine',
]);

// Overall execution floors over every measured module. The roster gate answers
// for modules no test loads; these answer for loaded code the suite never runs.
export const LINE_FLOOR = 92;
export const BRANCH_FLOOR = 93;

// Coverage measurement for the suite. The exclusions are code no unit test
// imports: the suites themselves, the engine's installed shader mirror, the
// generated Emscripten glue, and the scripts only a browser workflow runs.
export const COVERAGE = [
  '--experimental-test-coverage',
  '--test-coverage-exclude=tests/**',
  `--test-coverage-exclude=${fileURLToPath(new URL('./record-module-loads.mjs', import.meta.url))}`,
  '--test-coverage-exclude=generated/shader/**',
  '--test-coverage-exclude=generated/holosphere_wasm.js',
  '--test-coverage-exclude=generated/segment_geometry.js',
  '--test-coverage-exclude=scripts/browser-smoke.mjs',
];

export function totalCoverage(report) {
  const row = /^# all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/m.exec(report);
  if (!row) throw new Error('run-tests: coverage report has no totals row');
  return { lines: Number(row[1]), branches: Number(row[2]) };
}

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
  let totals;
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
    if (status === 0 && patterns.some((pattern) => pattern.includes('**'))
        && !/^ok \d+ - recursive test discovery reaches nested Node modules\s*$/m
          .test(readFileSync(reportPath, 'utf8'))) {
      console.error('run-tests: recursive discovery canary did not run.');
      status = 1;
    }
    if (status === 0 && process.env.CI
        && !/^# skipped 0\s*$/m.test(readFileSync(reportPath, 'utf8'))) {
      console.error('run-tests: CI must execute every test without skips.');
      status = 1;
    }
    if (status === 0 && process.env.CI
        && !/^# todo 0\s*$/m.test(readFileSync(reportPath, 'utf8'))) {
      console.error('run-tests: CI must execute every test without todos.');
      status = 1;
    }
    totals = totalCoverage(readFileSync(reportPath, 'utf8'));
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
    .filter((path) => !SKIP_DIRS.has(path.split('/')[0]))
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
  const uncovered = roster.filter((file) => !loaded.has(file) && !Object.hasOwn(exempt, file));
  const stale = Object.keys(exempt).filter((file) => !roster.includes(file)).sort();
  const redundant = Object.keys(exempt).filter((file) => loaded.has(file)).sort();
  const failures = [];
  if (totals.lines < LINE_FLOOR)
    failures.push(`run-tests: overall line coverage ${totals.lines}% is below the ${LINE_FLOOR}% floor.`);
  if (totals.branches < BRANCH_FLOOR)
    failures.push(`run-tests: overall branch coverage ${totals.branches}% is below the ${BRANCH_FLOOR}% floor.`);
  const block = (heading, files, remedy) =>
    `run-tests: ${heading}:\n${files.map((file) => `  ${file}`).join('\n')}\n${remedy}`;
  if (unreasoned.length > 0) failures.push(block(
    `every ${EXEMPT_PATH} entry must explain why no test can load the module`,
    unreasoned,
    'Add a concrete reason or delete the exemption.',
  ));
  if (uncovered.length > 0) failures.push(block(
    'no test loaded these source modules',
    uncovered,
    `Write a test that imports each, or record why it cannot be loaded in ${EXEMPT_PATH}.`,
  ));
  if (stale.length > 0) failures.push(block(
    `these ${EXEMPT_PATH} entries name no source module`, stale, 'Delete the stale exemptions.',
  ));
  if (redundant.length > 0) failures.push(block(
    `these ${EXEMPT_PATH} entries are loaded by a test after all`, redundant, 'Delete the redundant exemption.',
  ));
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }

  console.log(
    `run-tests: ${roster.filter((file) => loaded.has(file)).length} of ${roster.length} ` +
      `source modules were loaded by tests; the rest have reasoned exemptions in ${EXEMPT_PATH}.`,
  );
};

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
