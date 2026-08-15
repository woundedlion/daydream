// A node:test reporter tallying each file's results, for scripts/run-tests.mjs
// to gate per file. TAP attributes no result to a file — its totals are the
// whole run's — so neither the case counts nor the skips can be read off the
// report the gate already parses.
//
// Reported per file, over `test:pass`/`test:fail`:
//   ran     - tests that reached a result unskipped, which is the file's case
//             count; suites are their tests' parents, not results of their own,
//             so they are not counted.
//   skipped - results carrying a skip, suites included: a skipped suite is the
//             only result its subtree reports, since its cases never enqueue.
//   todo    - results carrying a todo. Node runs a todo body and reports its
//             failure as a pass, so a todo counts in `ran` and accrues its
//             assertions: neither floor can see one, and the gate refuses any
//             file reporting one.
// A file that skipped at least once and ran nothing is wholly skipped: gated on
// a prerequisite this platform lacks, and so exempt from its floors. A file
// that reported nothing at all is absent, and is exempt from nothing.

/**
 * @param {AsyncIterable<{type: string, data: Object}>} source - Runner events.
 * @yields {string} JSON object of `{ ran, skipped, todo }` per absolute file path.
 */
export default async function* reportCases(source) {
  const files = new Map();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { file, skip, todo, details } = event.data;
    if (!file) continue;
    const tally = files.get(file) ?? { ran: 0, skipped: 0, todo: 0 };
    if (todo !== undefined) tally.todo += 1;
    if (skip !== undefined) tally.skipped += 1;
    else if (details?.type !== 'suite') tally.ran += 1;
    files.set(file, tally);
  }
  const tallies = Object.fromEntries(
    [...files].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  yield `${JSON.stringify(tallies, null, 2)}\n`;
}
