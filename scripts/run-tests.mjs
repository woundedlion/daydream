// Run `node --test` over the patterns given on the command line, then gate what
// it reports against tests/assertion-floors.json, which commits two floors per
// test file: the cases it runs (measured by scripts/report-cases.mjs) and the
// assertions those cases make (measured by scripts/count-assertions.mjs), and
// against the source roster, which every module has to be loaded from somewhere
// in the suite to clear (measured by scripts/record-module-loads.mjs).
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
// shows up as a floors diff instead of a silently green run. A floor is a
// minimum, so cases landing after the last re-measure are covered by none;
// MAX_SURPLUS_CASES and MAX_SURPLUS_ASSERTIONS bound how many may sit
// unratcheted. Re-measure every floor in one run:
//   node scripts/run-tests.mjs --update-floors "tests/*.test.js"
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOORS_PATH = 'tests/assertion-floors.json';
// Source modules the suite is allowed to leave unloaded, each against the
// reason it cannot be covered. An absent file exempts nothing, so losing it
// tightens the gate rather than turning it off.
const EXEMPT_PATH = 'tests/uncovered-modules.json';
const UPDATE_FLAG = '--update-floors';
// Never walked for source modules: dependency and git metadata, the linked
// worktrees, the vendored third-party drops, and the engine checkout. Mirrors
// scripts/require-tests.mjs, which sweeps the same tree for test files.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.worktrees', 'vendor', 'three.js', 'engine',
]);
// Cases allowed to sit above the committed floors across the whole run. A floor
// left behind covers none of the cases that landed since, so those cases can be
// deleted again without tripping anything; the bound keeps that gap from growing
// without limit. scripts/require-tests.mjs holds the file count to exact
// equality for the same reason.
const MAX_SURPLUS_CASES = 64;
// The same allowance in assertions. Assertion counts are runtime invocations,
// so a loop inflates one file's tally without adding a call site; the bound is
// what keeps that from covering for floors nobody re-measured. Derived from
// MAX_SURPLUS_CASES at the suite's ~7 assertions per case, so both bounds
// forgive the same amount of unratcheted work.
const MAX_SURPLUS_ASSERTIONS = 450;

// The one spelling of the Node version the committed floors are measured
// against, read rather than copied so a bump cannot leave this behind.
const NODE_PIN_PATH = '.github/workflows/js-unit-suite.yml';
const COUNTER = new URL('./count-assertions.mjs', import.meta.url).href;
const CASE_REPORTER = new URL('./report-cases.mjs', import.meta.url).href;
const LOAD_RECORDER = new URL('./record-module-loads.mjs', import.meta.url).href;

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

// node:test retallies cases across majors, so floors measured on one major are
// not reproducible on another. Plain runs re-exec under the exact CI pin;
// re-measurements must start there so the process writing the floors is explicit.
// Fixture repos carry no workflow pin and continue under their invoking Node.
if (existsSync(NODE_PIN_PATH)) {
  const pin = readFileSync(NODE_PIN_PATH, 'utf8').match(/node-version: *'([\d.]+)'/)?.[1];
  if (!pin) {
    console.error(
      `run-tests: ${NODE_PIN_PATH} no longer spells a node-version pin, so the ` +
        'major the committed floors were measured on is unknown.',
    );
    process.exit(1);
  }
  const [pinMajor] = pin.split('.');
  const [runningMajor] = process.versions.node.split('.');
  if (updating && runningMajor !== pinMajor) {
    console.error(
      `run-tests: ${UPDATE_FLAG} must run on Node ${pinMajor}.x — CI measures the ` +
        `floors on ${pin}, and this is v${process.versions.node}.`,
    );
    process.exit(1);
  }
  if (runningMajor !== pinMajor) {
    console.error(
      `run-tests: Node v${process.versions.node} cannot reproduce the CI floors; ` +
        `re-running with Node ${pin}.`,
    );
    const npxArgs = ['--yes', `node@${pin}`, process.argv[1], ...argv];
    const command = process.platform === 'win32'
      ? (process.env.ComSpec ?? 'cmd.exe')
      : 'npx';
    const commandArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npx.cmd', ...npxArgs]
      : npxArgs;
    const rerun = spawnSync(command, commandArgs, { stdio: 'inherit' });
    if (rerun.error) {
      console.error(
        `run-tests: could not start Node ${pin} through npx (${rerun.error.message}).`,
      );
      process.exit(1);
    }
    process.exit(rerun.status ?? 1);
  }
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

// Directories the patterns draw test files from. Their contents are the suite,
// not the source the suite has to cover.
const testDirs = new Set(
  args
    .filter((a) => !a.startsWith('-'))
    .map((p) => p.split('/'))
    .map((parts) => parts.slice(0, parts.findIndex((s) => s.includes('*'))))
    .filter((parts) => parts.length > 0)
    .map((parts) => parts.join('/')),
);

// The default reporter depends on whether stdout is a TTY, so pin both: spec
// for the operator, the case tallies into a scratch file. A third reporter
// overruns node's listener budget on the runner's event stream and draws a
// MaxListenersExceededWarning, so the totals come from the tallies rather than
// from a TAP report of their own.
const scratch = mkdtempSync(join(tmpdir(), 'daydream-run-tests-'));
const casesPath = join(scratch, 'cases.json');
const countsDir = join(scratch, 'assertions');
const loadsDir = join(scratch, 'loads');
let status;
let tallied = false;
const counts = new Map();
// Cases each file ran, the files that ran nothing but a skip, and the files
// that reported a todo. All keyed as `counts` is.
const cases = new Map();
const skipped = new Set();
const todo = new Set();
// Repo-relative paths of every module a test process loaded.
const loaded = new Set();
try {
  mkdirSync(countsDir);
  mkdirSync(loadsDir);
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
      // NODE_OPTIONS rather than an execArgv flag: the counter and the load
      // recorder have to load in the processes the runner spawns per test file,
      // not in the runner.
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${COUNTER}` +
          ` --import ${LOAD_RECORDER}`,
        DAYDREAM_ASSERTION_COUNTS: countsDir,
        DAYDREAM_MODULE_LOADS: loadsDir,
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
  for (const entry of readdirSync(loadsDir)) {
    for (const url of JSON.parse(readFileSync(join(loadsDir, entry), 'utf8'))) {
      const key = keyOf(fileURLToPath(url.split(/[?#]/)[0]));
      if (!key.startsWith('..')) loaded.add(key);
    }
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
      if (tally.todo > 0) todo.add(key);
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
// A todo runs its body and is reported as a pass however it ends, so it clears
// both floors while asserting nothing that can fail. There is no opt-in for it,
// as there is for a skip: a case that cannot pass belongs in neither floor.
if (todo.size > 0) {
  console.error(
    'run-tests: these reported a todo, which passes whatever it does:\n' +
      [...todo]
        .sort()
        .map((file) => `  ${file}`)
        .join('\n') +
      '\nFix the case or delete it; a todo is not a floor either counter can gate.',
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
  // The write replaces the file with what this run measured, so a narrower
  // pattern than the suite would delete every floor outside it.
  const dropped = Object.keys(committed)
    .filter((file) => !(file in measured))
    .sort();
  if (dropped.length > 0) {
    console.error(
      'run-tests: these committed floors were not measured by this run, so ' +
        'writing would delete them:\n' +
        dropped.map((file) => `  ${file}`).join('\n') +
        '\nRe-measure every floor in one run — `node scripts/run-tests.mjs ' +
        `${UPDATE_FLAG} "tests/*.test.js"` +
        '` — or delete the entries by hand if their files are gone.',
    );
    process.exit(1);
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

// Ratchet: the file-count floor in package.json holds the number of test files,
// which says nothing about what they reach. A module nothing imports can land
// with a test file beside it and be covered by neither. The roster is every
// source module outside the suite's own directories, and clearing it takes a
// load: the recorder reports what the module loader resolved, so a mention in a
// comment or a string counts for nothing.
const roster = [];
const walkSource = (dir) => {
  for (const entry of readdirSync(dir === '' ? '.' : dir, { withFileTypes: true })) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !testDirs.has(path)) walkSource(path);
    } else if (/\.m?js$/.test(entry.name)) roster.push(path);
  }
};
walkSource('');
roster.sort();

let exempt = {};
if (existsSync(EXEMPT_PATH)) {
  try {
    exempt = JSON.parse(readFileSync(EXEMPT_PATH, 'utf8'));
  } catch (e) {
    console.error(`run-tests: ${EXEMPT_PATH} is unreadable (${e.code ?? e.message}).`);
    process.exit(1);
  }
}
const unreasoned = Object.entries(exempt)
  .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
  .map(([file]) => file)
  .sort();
if (unreasoned.length > 0) {
  console.error(
    `run-tests: every ${EXEMPT_PATH} entry must name why the module cannot be ` +
      'covered:\n' +
      unreasoned.map((file) => `  ${file}`).join('\n'),
  );
  process.exit(1);
}
/**
 * One reported block of modules the roster gate refused.
 * @param {string} heading - What the modules have in common.
 * @param {string[]} files - The modules, already sorted.
 * @param {string} remedy - What to do about them.
 * @returns {string} The block, without a trailing newline.
 */
const refused = (heading, files, remedy) =>
  `run-tests: ${heading}:\n${files.map((f) => `  ${f}`).join('\n')}\n${remedy}`;
const uncovered = roster.filter((file) => !loaded.has(file) && !(file in exempt));
const stale = Object.keys(exempt).filter((file) => !roster.includes(file)).sort();
const redundant = Object.keys(exempt).filter((file) => loaded.has(file)).sort();
const blocks = [];
if (uncovered.length > 0) {
  blocks.push(refused(
    'no test loaded these source modules',
    uncovered,
    `Write a test that imports each, or record why it cannot be one in ${EXEMPT_PATH}.`,
  ));
}
if (stale.length > 0) {
  blocks.push(refused(
    `these ${EXEMPT_PATH} entries name no source module`,
    stale,
    'Delete them; an exemption for a file that has gone away covers nothing.',
  ));
}
if (redundant.length > 0) {
  blocks.push(refused(
    `these ${EXEMPT_PATH} entries are covered after all`,
    redundant,
    'Delete them, or the exemption outlives the reason it was written for.',
  ));
}
if (blocks.length > 0) {
  console.error(blocks.join('\n'));
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
/**
 * What one counter runs above its committed floors.
 * @param {Map<string, number>} ran - Counts this run measured, keyed as the
 *   floors file is.
 * @param {string} key - Floors-entry field to compare against.
 * @returns {{rows: Array<[string, number, number]>, total: number}} Files over
 *   their floor, widest gap first, and the summed surplus.
 */
const aboveFloor = (ran, key) => {
  const rows = gated
    .map(([file, min]) => [file, ran.get(file) ?? 0, min[key]])
    .filter(([, count, min]) => count > min)
    .sort(([, countA, minA], [, countB, minB]) => countB - minB - (countA - minA));
  return { rows, total: rows.reduce((sum, [, count, min]) => sum + count - min, 0) };
};
const surplusCases = aboveFloor(cases, 'cases');
const surplusAssertions = aboveFloor(counts, 'assertions');
const overBound = [
  ['cases', surplusCases, MAX_SURPLUS_CASES],
  ['assertions', surplusAssertions, MAX_SURPLUS_ASSERTIONS],
].filter(([, { total }, bound]) => total > bound);
if (overBound.length > 0) {
  console.error(
    overBound
      .map(
        ([what, { rows, total }, bound]) =>
          `run-tests: ${total} ${what} above their committed floors, past the ` +
          `bound of ${bound}:\n` +
          rows
            .map(([file, count, min]) => `  ${file}: ${count} ran, floor ${min}`)
            .join('\n'),
      )
      .join('\n') +
      '\nThose are unratcheted, so deleting them again trips nothing. ' +
      `Ratchet the floors with \`node scripts/run-tests.mjs ${UPDATE_FLAG} ` +
      '<patterns>`.',
  );
  process.exit(1);
}
const surplus = surplusCases.total;
console.log(
  `run-tests: ${total} tests passed, ${assertions} assertions across ` +
    `${counts.size} files, each above its committed floor.\n` +
    `run-tests: ${roster.length - Object.keys(exempt).length} of ` +
    `${roster.length} source modules were loaded by a test, the rest exempt ` +
    `in ${EXEMPT_PATH}.` +
    (surplus > 0
      ? `\nrun-tests: ${surplus} cases above their committed floors ` +
        `(bound ${MAX_SURPLUS_CASES}) — ratchet them with ${UPDATE_FLAG}.`
      : '') +
    (surplusAssertions.total > 0
      ? `\nrun-tests: ${surplusAssertions.total} assertions above their ` +
        `committed floors (bound ${MAX_SURPLUS_ASSERTIONS}) — ratchet them ` +
        `with ${UPDATE_FLAG}.`
      : '') +
    (skipped.size > 0
      ? '\nrun-tests: exempted from their floors, wholly skipped:\n' +
        [...skipped]
          .sort()
          .map((f) => `  ${f}`)
          .join('\n')
      : ''),
);
