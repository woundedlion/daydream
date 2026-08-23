// Refuse an empty test glob, unreachable test files, and nested dependency
// installs that would make local and CI module resolution differ.
import { readdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const testScript = pkg.scripts?.test ?? '';
const glob =
  testScript.match(/["']([^"']*\*[^"']*)["']/)?.[1] ??
  testScript.split(/\s+/).find((token) => token.includes('*'));
if (!glob) {
  console.error('require-tests: no test glob found in package.json "test".');
  process.exit(1);
}

const parts = glob.split('/');
const globAt = parts.findIndex((part) => part.includes('*'));
const dir = globAt <= 0 ? '.' : parts.slice(0, globAt).join('/');
const suffix = glob.slice(glob.lastIndexOf('*') + 1);
const recursive = glob.includes('**');
const files = [];
const strays = [];
const unreachable = [];
const skipDirs = new Set(['.git', '.worktrees', 'three.js', 'vendor', 'engine']);

const scan = (current, depth) => {
  for (const entry of readdirSync(current ?? '.', { withFileTypes: true })) {
    const path = current === null ? entry.name : `${current}/${entry.name}`;
    if (entry.name === 'node_modules') {
      if (current !== null && depth !== null) strays.push(path);
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
if (unreachable.length > 0) {
  console.error(
    `require-tests: ${glob} does not reach:\n` +
      `${unreachable.map((path) => `  ${path}`).join('\n')}\n` +
      `Move them directly into ${dir}/, or widen the glob to ${dir}/**/*${suffix}.`,
  );
  process.exit(1);
}
if (strays.length > 0) {
  console.error(
    `require-tests: node_modules under ${dir}/ shadows the pinned root install:\n` +
      `${strays.map((path) => `  ${path}`).join('\n')}\n` +
      'Delete it and run `npm ci` at the repo root.',
  );
  process.exit(1);
}

console.log(
  `require-tests: ${files.length} files matched ${glob}; every test-shaped ` +
    'file is reachable and no nested install shadows the pinned dependencies.',
);
