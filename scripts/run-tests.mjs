// Run `node --test` over the patterns given on the command line, then gate what
// it reports against two committed ratchets: package.json's `testCountFloor`
// (cases) and tests/assertion-floors.json (per-file assertion counts, measured
// by scripts/count-assertions.mjs). Neither sees what the other does: a file
// gutted to a comment still scores one passing test, and a case gutted to an
// empty body still scores a pass while asserting nothing.
//
// Deleting a case drops its file below its floor, by design; a file that ran
// nothing but a skip is exempt, since a suite gated on a missing prerequisite
// asserts nothing without having gone away (see scripts/report-skips.mjs).
// Re-measure every assertion floor in one run:
//   node scripts/run-tests.mjs --update-floors "tests/*.test.js"
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const FLOORS_PATH = 'tests/assertion-floors.json';
const UPDATE_FLAG = '--update-floors';
const COUNTER = new URL('./count-assertions.mjs', import.meta.url).href;
const SKIP_REPORTER = new URL('./report-skips.mjs', import.meta.url).href;

const argv = process.argv.slice(2);
const updating = argv.includes(UPDATE_FLAG);
const args = argv.filter((a) => a !== UPDATE_FLAG);
// Without a pattern `node --test` walks the whole tree, which is a different
// suite than the one the floors were measured against.
if (!args.some((a) => !a.startsWith('-'))) {
  console.error(
    'run-tests: pass the test file patterns to run, e.g. ' +
      '`node scripts/run-tests.mjs "tests/*.test.js"`.',
  );
  process.exit(1);
}

// What each pattern accepts past its last wildcard, or the whole path for a
// literal one. Mirrors how scripts/require-tests.mjs reads the same globs.
const suffixes = args
  .filter((a) => !a.startsWith('-'))
  .map((p) => p.slice(p.lastIndexOf('*') + 1));

/**
 * Repo-relative, forward-slashed form of an absolute path, as the floors file
 * keys its entries.
 * @param {string} file - Absolute path.
 * @returns {string} Floors-file key.
 */
const keyOf = (file) => relative(process.cwd(), file).replaceAll('\\', '/');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const floor = pkg.testCountFloor;
if (!Number.isInteger(floor) || floor < 1) {
  console.error(
    'run-tests: package.json needs a "testCountFloor" (positive integer) — ' +
      'the committed total the test runner must report.',
  );
  process.exit(1);
}

// The default reporter depends on whether stdout is a TTY, so pin both ends:
// spec for the operator, TAP into a scratch file for the count.
const scratch = mkdtempSync(join(tmpdir(), 'daydream-run-tests-'));
const tapPath = join(scratch, 'summary.tap');
const skipsPath = join(scratch, 'skipped.json');
const countsDir = join(scratch, 'assertions');
let status;
let report = '';
const counts = new Map();
// Files that ran nothing but a skip, keyed as `counts` is.
const skipped = new Set();
try {
  mkdirSync(countsDir);
  const run = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=tap',
      `--test-reporter-destination=${tapPath}`,
      `--test-reporter=${SKIP_REPORTER}`,
      `--test-reporter-destination=${skipsPath}`,
      ...args,
    ],
    {
      stdio: 'inherit',
      // NODE_OPTIONS rather than an execArgv flag: the counter has to load in
      // the processes the runner spawns per test file, not in the runner.
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${COUNTER}`,
        DAYDREAM_ASSERTION_COUNTS: countsDir,
      },
    },
  );
  if (run.error) throw run.error;
  // A signalled runner reports a null status.
  status = run.status ?? 1;
  try {
    report = readFileSync(tapPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const entry of readdirSync(countsDir)) {
    const { file, count } = JSON.parse(
      readFileSync(join(countsDir, entry), 'utf8'),
    );
    const key = keyOf(file);
    // A test that spawns a script of its own inherits the counter, so keep only
    // the files the run's own patterns describe.
    if (!suffixes.some((s) => key.endsWith(s))) continue;
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  let skipReport = '';
  try {
    skipReport = readFileSync(skipsPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (skipReport.trim() !== '')
    for (const file of JSON.parse(skipReport)) skipped.add(keyOf(file));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (status !== 0) process.exit(status);

// Subtest summaries are indented, so an unindented line is the run total. Take
// the last in case a future reporter emits more than one.
const totals = [...report.matchAll(/^# pass (\d+)$/gm)];
if (totals.length === 0) {
  console.error(
    'run-tests: the test runner reported no total — refusing to report a ' +
      'green run.',
  );
  process.exit(1);
}
const total = Number(totals[totals.length - 1][1]);

// An empty map means the counter never loaded, which would leave the assertion
// ratchet silently off.
if (counts.size === 0) {
  console.error(
    'run-tests: no assertion counts were reported — refusing to report a ' +
      'green run.',
  );
  process.exit(1);
}
const measured = Object.fromEntries(
  [...counts].sort(([a], [b]) => (a < b ? -1 : 1)),
);
const assertions = [...counts.values()].reduce((a, b) => a + b, 0);

if (updating) {
  // A wholly skipped file measured nothing, so re-measuring here would ratchet
  // its floor to zero and retire it. Keep whatever it has committed.
  let committed = {};
  try {
    committed = JSON.parse(readFileSync(FLOORS_PATH, 'utf8'));
  } catch {
    /* no floors yet: there is nothing to keep */
  }
  for (const file of skipped)
    if (file in measured && Number.isInteger(committed[file]))
      measured[file] = committed[file];
  writeFileSync(FLOORS_PATH, `${JSON.stringify(measured, null, 2)}\n`);
  console.log(
    `run-tests: wrote ${counts.size} floors to ${FLOORS_PATH} ` +
      `(${assertions} assertions). Set "testCountFloor" to ${total} in ` +
      'package.json to re-measure the case total too.',
  );
  process.exit(0);
}

// Ratchet: raised as tests land, lowered only alongside a deliberate removal.
if (total < floor) {
  console.error(
    `Only ${total} tests passed; the committed floor is ${floor}. Restore ` +
      'the missing cases, or lower "testCountFloor" in package.json if the ' +
      'removal was intended.',
  );
  process.exit(1);
}

let floors;
try {
  floors = JSON.parse(readFileSync(FLOORS_PATH, 'utf8'));
} catch (e) {
  console.error(
    `run-tests: ${FLOORS_PATH} is missing or unreadable (${e.code ?? e.message}) ` +
      `— write it with \`node scripts/run-tests.mjs ${UPDATE_FLAG} <patterns>\`.`,
  );
  process.exit(1);
}
const malformed = Object.entries(floors).filter(
  ([, min]) => !Number.isInteger(min) || min < 0,
);
if (malformed.length > 0) {
  console.error(
    `run-tests: ${FLOORS_PATH} floors must be non-negative integers:\n` +
      malformed.map(([file, min]) => `  ${file}: ${min}`).join('\n'),
  );
  process.exit(1);
}
// A file that ran without a floor is unratcheted, so it is an error rather than
// a default of zero: a new test file has to commit its measured count.
const unlisted = [...counts.keys()].filter((f) => !(f in floors)).sort();
if (unlisted.length > 0) {
  console.error(
    'run-tests: no assertion floor committed for:\n' +
      unlisted.map((f) => `  ${f}: ${counts.get(f)}`).join('\n') +
      `\nAdd them with \`node scripts/run-tests.mjs ${UPDATE_FLAG} <patterns>\`.`,
  );
  process.exit(1);
}
// A deleted or renamed file reports zero against its committed floor. A file
// whose every result was a skip is exempt instead: it reported results, so it
// is still there, and a platform-gated suite asserts nothing by design.
const short = Object.entries(floors)
  .map(([file, min]) => [file, counts.get(file) ?? 0, min])
  .filter(([file, ran, min]) => ran < min && !skipped.has(file));
if (short.length > 0) {
  console.error(
    'run-tests: assertions ran below the committed floor:\n' +
      short
        .map(([file, ran, min]) => `  ${file}: ${ran} ran, floor ${min}`)
        .join('\n') +
      '\nRestore the missing assertions, or re-measure with ' +
      `\`node scripts/run-tests.mjs ${UPDATE_FLAG} <patterns>\` if the removal ` +
      'was intended.',
  );
  process.exit(1);
}
console.log(
  `run-tests: ${total} tests passed (committed floor ${floor}), ` +
    `${assertions} assertions across ${counts.size} files.` +
    (skipped.size > 0
      ? '\nrun-tests: exempted from their assertion floors, wholly skipped:\n' +
        [...skipped]
          .sort()
          .map((f) => `  ${f}`)
          .join('\n')
      : ''),
);
