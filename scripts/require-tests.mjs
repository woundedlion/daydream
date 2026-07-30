// Guard the test glob: `node --test "tests/*.test.js"` reports a green run on a
// zero-match glob, so a rename/move that empties tests/ would pass CI silently.
import { readdirSync, readFileSync } from 'node:fs';

// Derive the directory and suffix from package.json's `test` script glob so this
// guard tracks the pattern node --test actually runs instead of restating it.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const testScript = pkg.scripts?.test ?? '';
const glob =
  testScript.match(/["']([^"']*\*[^"']*)["']/)?.[1] ??
  testScript.split(/\s+/).find((t) => t.includes('*'));
if (!glob) {
  console.error(
    'require-tests: no test glob found in the package.json "test" script.',
  );
  process.exit(1);
}
// Base directory is the path before the first globbed segment; only a `**`
// segment descends, so anything deeper is out of the pattern's reach.
const parts = glob.split('/');
const globAt = parts.findIndex((p) => p.includes('*'));
const dir = globAt <= 0 ? '.' : parts.slice(0, globAt).join('/');
const suffix = glob.slice(glob.lastIndexOf('*') + 1);
const recursive = glob.includes('**');

const files = [];
// A node_modules at or below the test dir shadows the pinned root install for
// every test file, so local runs and CI resolve different copies of a
// dependency. Junctions and symlinks report as neither file nor directory, so
// match the name before the type. The root install is the one the tests are
// supposed to resolve to, so it is skipped rather than flagged.
const strays = [];
// Test files the glob cannot reach: they are committed, look like tests, and
// never run. The sweep starts at the repo root, so a sibling directory hides
// one no better than a subdirectory of the test dir does.
const unreachable = [];
// Never entered: git metadata and the vendored third-party drops the page
// serves, both of which carry test files of their own.
const skipDirs = new Set(['.git', 'three.js', 'vendor']);
// `depth` is the distance below the glob's base dir, or null outside it. The
// root is scanned as `null` so paths read as they do in the repo.
const scan = (d, depth) => {
  for (const entry of readdirSync(d ?? '.', { withFileTypes: true })) {
    const path = d === null ? entry.name : `${d}/${entry.name}`;
    if (entry.name === 'node_modules') {
      if (d !== null && depth !== null) strays.push(path);
    } else if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      scan(path, depth === null ? (path === dir ? 0 : null) : depth + 1);
    } else if (!entry.name.endsWith(suffix)) continue;
    else if (depth === 0 || (recursive && depth !== null)) files.push(path);
    else unreachable.push(path);
  }
};
scan(null, dir === '.' ? 0 : null);

if (files.length === 0) {
  console.error(`No files matched ${glob} — refusing to report a green run.`);
  process.exit(1);
}

// Ratchet: a match count alone still reports green after all but one test file
// is deleted or renamed out of the glob. The floor is committed in package.json
// and raised as test files land; lower it only alongside a deliberate removal.
const floor = pkg.testFileFloor;
if (!Number.isInteger(floor) || floor < 0) {
  console.error(
    'require-tests: package.json needs a "testFileFloor" (non-negative ' +
      'integer) — the committed count of files the test glob must match.',
  );
  process.exit(1);
}
if (files.length < floor) {
  console.error(
    `Only ${files.length} files matched ${glob}; the committed floor is ` +
      `${floor}. Restore the missing tests, or lower "testFileFloor" in ` +
      'package.json if the removal was intended.',
  );
  process.exit(1);
}

if (unreachable.length > 0) {
  console.error(
    `require-tests: ${glob} does not reach:\n` +
      `${unreachable.map((p) => `  ${p}`).join('\n')}\n` +
      `Move them directly into ${dir}/, or widen the glob to ${dir}/**/*${suffix}.`,
  );
  process.exit(1);
}

if (strays.length > 0) {
  console.error(
    `require-tests: node_modules under ${dir}/ shadows the pinned root ` +
      `install:\n${strays.map((p) => `  ${p}`).join('\n')}\n` +
      'Delete it and run `npm ci` at the repo root.',
  );
  process.exit(1);
}
