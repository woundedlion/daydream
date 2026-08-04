// A node:test reporter naming the files that ran nothing but a skip, for
// scripts/run-tests.mjs to exempt from their assertion floors: a suite gated on
// a missing prerequisite (`describe(name, { skip }, ...)`) measures no
// assertions, and that is a different state from a file that was deleted. TAP
// attributes no result to a file, so the gate cannot read this off the report.
//
// Reported per file, over `test:pass`/`test:fail`:
//   ran     - tests that reached a result unskipped; suites are their parents,
//             not results of their own, so they are not counted.
//   skipped - results carrying a skip, suites included: a skipped suite is the
//             only result its subtree reports.
// A file is wholly skipped when it skipped at least once and ran nothing.

/**
 * @param {AsyncIterable<{type: string, data: Object}>} source - Runner events.
 * @yields {string} JSON array of the wholly skipped files, absolute paths.
 */
export default async function* reportSkips(source) {
  const files = new Map();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { file, skip, details } = event.data;
    if (!file) continue;
    const tally = files.get(file) ?? { ran: 0, skipped: 0 };
    if (skip !== undefined) tally.skipped += 1;
    else if (details?.type !== 'suite') tally.ran += 1;
    files.set(file, tally);
  }
  const wholly = [...files]
    .filter(([, t]) => t.skipped > 0 && t.ran === 0)
    .map(([file]) => file)
    .sort();
  yield `${JSON.stringify(wholly, null, 2)}\n`;
}
