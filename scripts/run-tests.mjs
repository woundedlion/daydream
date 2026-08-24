// Run the requested node:test suite, then verify that every first-party source
// module was loaded by a test or has a reasoned exemption.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXEMPT_PATH = 'tests/uncovered-modules.json';
const LOAD_RECORDER = new URL('./record-module-loads.mjs', import.meta.url).href;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.worktrees', 'vendor', 'three.js', 'engine',
]);

const args = process.argv.slice(2);
const patterns = args.filter((arg) => !arg.startsWith('-'));
if (patterns.length === 0) {
  console.error(
    'run-tests: pass the test file patterns to run, e.g. ' +
      '`node scripts/run-tests.mjs "tests/**/*.test.js"`.',
  );
  process.exit(1);
}

const keyOf = (file) => relative(process.cwd(), file).replaceAll('\\', '/');
const testDirs = new Set(
  patterns
    .map((pattern) => pattern.split('/'))
    .map((parts) => parts.slice(0, parts.findIndex((part) => part.includes('*'))))
    .filter((parts) => parts.length > 0)
    .map((parts) => parts.join('/')),
);

const scratch = mkdtempSync(join(tmpdir(), 'daydream-run-tests-'));
const loadsDir = join(scratch, 'loads');
const loaded = new Set();
let status;
try {
  mkdirSync(loadsDir);
  const run = spawnSync(process.execPath, ['--test', ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${LOAD_RECORDER}`,
      DAYDREAM_MODULE_LOADS: loadsDir,
    },
  });
  if (run.error) throw run.error;
  status = run.status ?? 1;
  for (const entry of readdirSync(loadsDir)) {
    for (const url of JSON.parse(readFileSync(join(loadsDir, entry), 'utf8'))) {
      const key = keyOf(fileURLToPath(url.split(/[?#]/)[0]));
      if (!key.startsWith('..')) loaded.add(key);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (status !== 0) process.exit(status);

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
  } catch (error) {
    console.error(`run-tests: ${EXEMPT_PATH} is unreadable (${error.code ?? error.message}).`);
    process.exit(1);
  }
}
const unreasoned = Object.entries(exempt)
  .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
  .map(([file]) => file)
  .sort();
const uncovered = roster.filter((file) => !loaded.has(file) && !(file in exempt));
const stale = Object.keys(exempt).filter((file) => !roster.includes(file)).sort();
const redundant = Object.keys(exempt).filter((file) => loaded.has(file)).sort();
const failures = [];
const block = (heading, files, remedy) =>
  `run-tests: ${heading}:\n${files.map((file) => `  ${file}`).join('\n')}\n${remedy}`;
if (unreasoned.length > 0) failures.push(block(
  `every ${EXEMPT_PATH} entry must explain why the module cannot be covered`,
  unreasoned,
  'Add a concrete reason or delete the exemption.',
));
if (uncovered.length > 0) failures.push(block(
  'no test loaded these source modules',
  uncovered,
  `Write a test that imports each, or record why it cannot be covered in ${EXEMPT_PATH}.`,
));
if (stale.length > 0) failures.push(block(
  `these ${EXEMPT_PATH} entries name no source module`, stale, 'Delete the stale exemptions.',
));
if (redundant.length > 0) failures.push(block(
  `these ${EXEMPT_PATH} entries are covered after all`, redundant, 'Delete the redundant exemptions.',
));
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  `run-tests: ${roster.length - Object.keys(exempt).length} of ${roster.length} ` +
    `source modules were loaded by tests; the rest have reasoned exemptions in ${EXEMPT_PATH}.`,
);
