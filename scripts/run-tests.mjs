// Run the requested node:test suite, then verify that every first-party source
// module was loaded by a test or has a reasoned exemption.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
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

export function lineCoverage(report, column = 0) {
  const files = new Map();
  const directories = [];
  let active = false;
  for (const line of report.split(/\r?\n/)) {
    if (line === '# start of coverage report') { active = true; continue; }
    if (line === '# end of coverage report') break;
    if (!active) continue;
    const row = /^# (\s*)([^|]+?)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/.exec(line);
    if (!row || ['file', 'all files'].includes(row[2].trim())) continue;
    const [, padding, name, percent] = row;
    while (directories.length && directories.at(-1).depth >= padding.length)
      directories.pop();
    if (percent === '') {
      directories.push({ depth: padding.length, name: name.trim() });
    } else {
      files.set([...directories.map((entry) => entry.name), name.trim()].join('/'),
        Number(row[3 + column]));
    }
  }
  if (files.size === 0) throw new Error('run-tests: coverage report has no file rows');
  return files;
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
  let coverage;
  let branches;
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
    coverage = lineCoverage(readFileSync(reportPath, 'utf8'));
    branches = lineCoverage(readFileSync(reportPath, 'utf8'), 1);
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
    .filter(([, entry]) => {
      const reason = typeof entry === 'string' ? entry : entry?.reason;
      return typeof reason !== 'string' || reason.trim() === ''
        || (typeof entry !== 'string'
          && ((!('lines' in entry) && !('branches' in entry))
            || Object.entries({ lines: 95, branches: 90 }).some(([metric, limit]) =>
              metric in entry && (!Number.isFinite(entry[metric])
                || entry[metric] <= 0 || entry[metric] >= limit))));
    })
    .map(([file]) => file)
    .sort();
  const uncovered = roster.filter((file) => !loaded.has(file) && typeof exempt[file] !== 'string');
  const stale = Object.keys(exempt).filter((file) => !roster.includes(file)).sort();
  const redundant = Object.keys(exempt).filter((file) =>
    typeof exempt[file] === 'string' ? loaded.has(file)
      : Object.keys(exempt[file]).filter((key) => key !== 'reason').some((key) =>
        (key === 'lines' ? coverage.get(file) >= 95 : branches.get(file) >= 90))).sort();
  const failures = [];
  for (const [file, lines] of coverage) {
    if (!roster.includes(file)) continue;
    const floor = exempt[file]?.lines ?? 95;
    if (lines < floor)
      failures.push(`run-tests: ${file} line coverage ${lines}% is below its ${floor}% floor.`);
    const branchFloor = exempt[file]?.branches ?? 90;
    if (branches.get(file) < branchFloor)
      failures.push(`run-tests: ${file} branch coverage ${branches.get(file)}% is below its ${branchFloor}% floor.`);
  }
  for (const [file, entry] of Object.entries(exempt)) {
    if (typeof entry !== 'string' && !coverage.has(file))
      failures.push(`run-tests: ${file} has a coverage baseline but no measured file row.`);
  }
  const block = (heading, files, remedy) =>
    `run-tests: ${heading}:\n${files.map((file) => `  ${file}`).join('\n')}\n${remedy}`;
  if (unreasoned.length > 0) failures.push(block(
    `every ${EXEMPT_PATH} entry must explain why coverage is limited and use a valid floor`,
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
    `run-tests: ${roster.filter((file) => loaded.has(file)).length} of ${roster.length} ` +
      `source modules were loaded by tests; the rest have reasoned exemptions in ${EXEMPT_PATH}.`,
  );
};

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
