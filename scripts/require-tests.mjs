// Guard the test glob: `node --test "tests/*.test.js"` reports a green run on a
// zero-match glob, so a rename/move that empties tests/ would pass CI silently.
import { readdirSync } from 'node:fs';

let files = [];
try {
  files = readdirSync('tests').filter((f) => f.endsWith('.test.js'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (files.length === 0) {
  console.error('No files matched tests/*.test.js — refusing to report a green run.');
  process.exit(1);
}
