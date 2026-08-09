// Run `node --test` over the patterns given on the command line, then gate what
// it reports against tests/assertion-floors.json, which commits two floors per
// test file: the cases it runs (measured by scripts/report-cases.mjs) and the
// assertions those cases make (measured by scripts/count-assertions.mjs).
// Neither floor sees what the other does: a file gutted to a comment still
// scores the one pass node reports for a file with no cases, and a case gutted
// to an empty body still scores a pass while asserting nothing.
//
// The floors are per file rather than per run so that one file going quiet is
// not paid for by another growing. Deleting a case drops its file below its
// floor, by design; a file that ran nothing but a skip is exempt, since a suite
// gated on a prerequisite the platform lacks runs nothing without having gone
// away. That exemption is opt-in: the file's floors entry must carry
// `"skippable": true`, so an unconditional skip retiring a file from gating
// shows up as a floors diff instead of a silently green run. Re-measure every
// floor in one run:
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
const CASE_REPORTER = new URL('./report-cases.mjs', import.meta.url).href;

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

// The default reporter depends on whether stdout is a TTY, so pin both: spec
// for the operator, the case tallies into a scratch file. A third reporter
// overruns node's listener budget on the runner's event stream and draws a
// MaxListenersExceededWarning, so the totals come from the tallies rather than
// from a TAP report of their own.
const scratch = mkdtempSync(join(tmpdir(), 'daydream-run-tests-'));
const casesPath = join(scratch, 'cases.json');
const countsDir = join(scratch, 'assertions');
let status;
let tallied = false;
const counts = new Map();
// Cases each file ran, and the files that ran nothing but a skip. Both keyed
// as `counts` is.
const cases = new Map();
const skipped = new Set();
try {
  mkdirSync(countsDir);
  const run = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${CASE_REPORTER}`,
      `--test-reporter-destination=${casesPath}`,
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
  for (const entry of readdirSync(countsDir)) {
    const { file, count } = JSON.parse(
      readFileSync(join(countsDir, entry), 'utf8'),
    );
    const key = keyOf(file);
    // A test that spawns a script of its own inherits the counter, so keep only
    // the files the run's own patterns describe.
    if (key.startsWith('..') || !suffixes.some((s) => key.endsWith(s))) continue;
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  let tallies = '';
  try {
    tallies = readFileSync(casesPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (tallies.trim() !== '') {
    tallied = true;
    for (const [file, tally] of Object.entries(JSON.parse(tallies))) {
      const key = keyOf(file);
      cases.set(key, tally.ran);
      if (tally.skipped > 0 && tally.ran === 0) skipped.add(key);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (status !== 0) process.exit(status);

// An empty map means the counter never loaded, and no tallies means the
// reporter never loaded; either would leave a ratchet silently off.
if (counts.size === 0) {
  console.error(
    'run-tests: no assertion counts were reported — refusing to report a ' +
      'green run.',
  );
  process.exit(1);
}
if (!tallied) {
  console.error(
    'run-tests: no case counts were reported — refusing to report a green run.',
  );
  process.exit(1);
}
const total = [...cases.values()].reduce((a, b) => a + b, 0);
const assertions = [...counts.values()].reduce((a, b) => a + b, 0);
const measured = Object.fromEntries(
  [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, count]) => [
      file,
      { cases: cases.get(file) ?? 0, assertions: count },
    ]),
);

/**
 * Whether a committed floor entry is a usable pair.
 * @param {unknown} min - Entry read from the floors file.
 * @returns {boolean} True when both counts are non-negative integers and any
 *   skippable declaration is a boolean.
 */
const sound = (min) =>
  min !== null &&
  typeof min === 'object' &&
  Number.isInteger(min.cases) &&
  min.cases >= 0 &&
  Number.isInteger(min.assertions) &&
  min.assertions >= 0 &&
  (min.skippable === undefined || typeof min.skippable === 'boolean');

if (updating) {
  // A file that ran cases and counted nothing is either gutted or asserting
  // where the counter cannot see: `assert(x)` calls the callable each assert
  // module exports as its default, a binding rather than a property, so
  // scripts/count-assertions.mjs never wraps it. Either way a floor of zero
  // assertions gates nothing while reading as a committed floor, so it is
  // refused rather than written.
  const silent = Object.entries(measured)
    .filter(([, min]) => min.cases > 0 && min.assertions === 0)
    .map(([file]) => file)
    .sort();
  if (silent.length > 0) {
    console.error(
      'run-tests: these ran cases and counted no assertions, which is not a ' +
        'floor worth committing:\n' +
        silent.map((file) => `  ${file}`).join('\n') +
        '\nGive each case an assertion, and call node:assert through a ' +
        'property — `assert.ok(x)` rather than `assert(x)`, which is not ' +
        'counted.',
    );
    process.exit(1);
  }
  // A wholly skipped file measured nothing, so re-measuring here would ratchet
  // its floors to zero and retire it. Keep whatever it has committed.
  let committed = {};
  try {
    committed = JSON.parse(readFileSync(FLOORS_PATH, 'utf8'));
  } catch {
    /* no floors yet: there is nothing to keep */
  }
  for (const file of skipped)
    if (file in measured && sound(committed[file]))
      measured[file] = committed[file];
  // A skippable file that did run here still needs its declaration carried
  // over, or re-measuring on a machine holding the prerequisite would strip it.
  for (const [file, min] of Object.entries(committed))
    if (file in measured && min?.skippable === true)
      measured[file] = { ...measured[file], skippable: true };
  writeFileSync(FLOORS_PATH, `${JSON.stringify(measured, null, 2)}\n`);
  console.log(
    `run-tests: wrote ${counts.size} floors to ${FLOORS_PATH} ` +
      `(${total} cases, ${assertions} assertions).`,
  );
  process.exit(0);
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
const malformed = Object.entries(floors).filter(([, min]) => !sound(min));
if (malformed.length > 0) {
  console.error(
    `run-tests: every ${FLOORS_PATH} entry must be a {"cases", "assertions"} ` +
      'pair of non-negative integers:\n' +
      malformed
        .map(([file, min]) => `  ${file}: ${JSON.stringify(min)}`)
        .join('\n'),
  );
  process.exit(1);
}
// A file that ran without a floor is unratcheted, so it is an error rather than
// a default of zero: a new test file has to commit its measured counts.
const unlisted = [...counts.keys()].filter((f) => !(f in floors)).sort();
if (unlisted.length > 0) {
  console.error(
    'run-tests: no floors committed for:\n' +
      unlisted
        .map((f) => `  ${f}: ${JSON.stringify(measured[f])}`)
        .join('\n') +
      `\nAdd them with \`node scripts/run-tests.mjs ${UPDATE_FLAG} <patterns>\`.`,
  );
  process.exit(1);
}
// A deleted or renamed file reports zero against both its floors. A file whose
// every result was a skip is exempt instead: it reported results, so it is
// still there, and a platform-gated suite runs nothing by design. The exemption
// is opt-in, so an unconditional skip cannot quietly retire a file.
const undeclaredSkips = [...skipped]
  .filter((file) => floors[file]?.skippable !== true)
  .sort();
if (undeclaredSkips.length > 0) {
  console.error(
    'run-tests: every result was a skip, and the floors do not allow it:\n' +
      undeclaredSkips.map((file) => `  ${file}`).join('\n') +
      `\nRun the suite, or declare the file skippable in ${FLOORS_PATH} ` +
      '(add `"skippable": true` to its entry) if its prerequisite is genuinely ' +
      'optional.',
  );
  process.exit(1);
}
const gated = Object.entries(floors).filter(([file]) => !skipped.has(file));
const belowCases = gated
  .map(([file, min]) => [file, cases.get(file) ?? 0, min.cases])
  .filter(([, ran, min]) => ran < min);
const belowAssertions = gated
  .map(([file, min]) => [file, counts.get(file) ?? 0, min.assertions])
  .filter(([, ran, min]) => ran < min);
/**
 * One reported block of files that came in under a floor.
 * @param {string} what - What was counted, for the heading.
 * @param {Array<[string, number, number]>} rows - File, count run, floor.
 * @returns {string} The block, without a trailing newline.
 */
const block = (what, rows) =>
  `run-tests: ${what} ran below the committed floor:\n` +
  rows
    .map(([file, ran, min]) => `  ${file}: ${ran} ran, floor ${min}`)
    .join('\n');
if (belowCases.length + belowAssertions.length > 0) {
  const blocks = [];
  if (belowCases.length > 0) blocks.push(block('cases', belowCases));
  if (belowAssertions.length > 0)
    blocks.push(block('assertions', belowAssertions));
  console.error(
    `${blocks.join('\n')}\nRestore what went missing, or re-measure with ` +
      `\`node scripts/run-tests.mjs ${UPDATE_FLAG} <patterns>\` if the removal ` +
      'was intended.',
  );
  process.exit(1);
}
console.log(
  `run-tests: ${total} tests passed, ${assertions} assertions across ` +
    `${counts.size} files, each above its committed floor.` +
    (skipped.size > 0
      ? '\nrun-tests: exempted from their floors, wholly skipped:\n' +
        [...skipped]
          .sort()
          .map((f) => `  ${f}`)
          .join('\n')
      : ''),
);
