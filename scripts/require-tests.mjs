// Guard the test glob: `node --test "tests/*.test.js"` reports a green run on a
// zero-match glob, so a rename/move that empties tests/ would pass CI silently.
import { readdirSync, readFileSync } from 'node:fs';

// Derive the directory and suffix from package.json's `test` script glob so this
// guard tracks the pattern node --test actually runs instead of restating it.
const testScript =
  JSON.parse(readFileSync('package.json', 'utf8')).scripts?.test ?? '';
const glob =
  testScript.match(/["']([^"']*\*[^"']*)["']/)?.[1] ??
  testScript.split(/\s+/).find((t) => t.includes('*'));
if (!glob) {
  console.error(
    'require-tests: no test glob found in the package.json "test" script.',
  );
  process.exit(1);
}
const slash = glob.lastIndexOf('/');
const dir = slash === -1 ? '.' : glob.slice(0, slash);
const suffix = glob.slice(glob.lastIndexOf('*') + 1);

let files = [];
try {
  files = readdirSync(dir).filter((f) => f.endsWith(suffix));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (files.length === 0) {
  console.error(`No files matched ${glob} — refusing to report a green run.`);
  process.exit(1);
}
