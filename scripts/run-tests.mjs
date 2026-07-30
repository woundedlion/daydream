// Run `node --test` over the patterns given on the command line, then gate the
// total it reports against package.json's committed `testCountFloor`. A file
// count cannot see this: `node --test` counts a test file gutted to a comment as
// one passing test, so deleting every case inside it still reports a green run.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
// Without a pattern `node --test` walks the whole tree, which is a different
// suite than the one the floor was measured against.
if (!args.some((a) => !a.startsWith('-'))) {
  console.error(
    'run-tests: pass the test file patterns to run, e.g. ' +
      '`node scripts/run-tests.mjs "tests/*.test.js"`.',
  );
  process.exit(1);
}

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
let status;
let report = '';
try {
  const run = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=tap',
      `--test-reporter-destination=${tapPath}`,
      ...args,
    ],
    { stdio: 'inherit' },
  );
  if (run.error) throw run.error;
  // A signalled runner reports a null status.
  status = run.status ?? 1;
  try {
    report = readFileSync(tapPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
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

// Ratchet: raised as tests land, lowered only alongside a deliberate removal.
if (total < floor) {
  console.error(
    `Only ${total} tests passed; the committed floor is ${floor}. Restore ` +
      'the missing cases, or lower "testCountFloor" in package.json if the ' +
      'removal was intended.',
  );
  process.exit(1);
}
console.log(`run-tests: ${total} tests passed (committed floor ${floor}).`);
