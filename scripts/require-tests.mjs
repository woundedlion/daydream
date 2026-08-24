// Refuse an empty test glob, unreachable test files, and nested dependency
// installs that would make local and CI module resolution differ.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const testScript = pkg.scripts?.test ?? '';
const quotedGlobs = [...testScript.matchAll(/["']([^"']*\*[^"']*)["']/g)]
  .map((match) => match[1]);
const globs = quotedGlobs.length > 0
  ? quotedGlobs
  : testScript.split(/\s+/).filter((token) => token.includes('*'));
if (globs.length === 0) {
  console.error('require-tests: no test glob found in package.json "test".');
  process.exit(1);
}

const globPattern = (glob) => {
  let pattern = '^';
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        pattern += '(?:.*/)?';
        i += 2;
      } else {
        pattern += '.*';
        i += 1;
      }
    } else if (glob[i] === '*') {
      pattern += '[^/]*';
    } else if (glob[i] === '?') {
      pattern += '[^/]';
    } else {
      pattern += glob[i].replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`);
};
const globSpecs = globs.map((glob) => {
  const parts = glob.split('/');
  const globAt = parts.findIndex((part) => part.includes('*'));
  return {
    dir: globAt <= 0 ? '.' : parts.slice(0, globAt).join('/'),
    pattern: globPattern(glob),
  };
});
const skipDirs = new Set(['.git', '.worktrees', 'three.js', 'vendor', 'engine']);
const testShape = /\.(?:test|spec)\.m?js$/;
const tracked = String(execFileSync('git', ['ls-files', '-z']))
  .split('\0')
  .filter((path) => path !== '' && existsSync(path) && /\.m?js$/.test(path))
  .filter((path) => !path.split('/').some((part) => skipDirs.has(part)));
const reachableBy = (path, spec) => spec.pattern.test(path);
const files = tracked.filter((path) =>
  globSpecs.some((spec) => reachableBy(path, spec)));
const unreachable = tracked
  .filter((path) => testShape.test(path))
  .filter((path) => !globSpecs.some((spec) => reachableBy(path, spec)));

const strays = [];
const scanInstalls = (current) => {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = current === '.' ? entry.name : `${current}/${entry.name}`;
    if (entry.name === 'node_modules') {
      if (current !== '.') strays.push(path);
    } else if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      scanInstalls(path);
    }
  }
};
for (const dir of new Set(globSpecs.map((spec) => spec.dir))) {
  if (existsSync(dir)) scanInstalls(dir);
}

if (files.length === 0) {
  console.error(
    `No files matched ${globs.join(', ')} — refusing to report a green run.`,
  );
  process.exit(1);
}
if (unreachable.length > 0) {
  console.error(
    `require-tests: ${globs.join(', ')} does not reach:\n` +
      `${unreachable.map((path) => `  ${path}`).join('\n')}\n` +
      'Add runner patterns that reach every conventional test/spec file.',
  );
  process.exit(1);
}
if (strays.length > 0) {
  console.error(
    'require-tests: node_modules under the test roots shadows the pinned ' +
      'root install:\n' +
      `${strays.map((path) => `  ${path}`).join('\n')}\n` +
      'Delete it and run `npm ci` at the repo root.',
  );
  process.exit(1);
}

console.log(
  `require-tests: ${files.length} files matched ${globs.join(', ')}; every ` +
    'conventional test/spec file is reachable and no nested install shadows ' +
    'the pinned dependencies.',
);
