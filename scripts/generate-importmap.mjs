/*
 * Bakes the local-vs-CDN vendoring decision into vendor-importmap.js at build
 * time.
 *
 *   node scripts/generate-importmap.mjs            # all-CDN (default, deploy-safe)
 *   node scripts/generate-importmap.mjs --local    # local where vendored, else CDN
 *   node scripts/generate-importmap.mjs --out F    # write to F instead of vendor-importmap.js
 *
 * `--local` checks the filesystem for the vendored library entry points and
 * sets each library to 'local' only when present, so a partial vendoring
 * (e.g. node_modules but no three.js/) still resolves correctly.
 *
 * Only the GENERATED block in vendor-importmap.js is rewritten: the vendoring
 * decision, the version pins, and the Subresource Integrity hashes. The version
 * pins are read from package.json so the importmap and the dependency manifest
 * share one source of truth. The rest of the file (page-relative resolution) is
 * untouched.
 *
 * Every CDN-resolved module gets a sha384 hash computed from the installed
 * node_modules copy, which jsDelivr serves byte-for-byte from the same npm
 * tarball. Hashing therefore requires the pinned versions to be installed, and
 * the script refuses to run against a missing or mismatched node_modules rather
 * than baking a hash that would block the module on the deployed site.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'vendor-importmap.js');

const local = process.argv.includes('--local');
const outIndex = process.argv.indexOf('--out');
const TARGET = outIndex === -1 ? SOURCE : process.argv[outIndex + 1];
if (TARGET === undefined || TARGET.startsWith('--')) {
  console.error('generate-importmap: --out requires a path');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const versions = {
  three: pkg.dependencies?.three,
  lilGui: pkg.dependencies?.['lil-gui'],
};
for (const [lib, name] of [['three', 'three'], ['lilGui', 'lil-gui']]) {
  if (typeof versions[lib] !== 'string' || versions[lib] === '') {
    console.error(`generate-importmap: package.json dependencies.${name} is missing or empty`);
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(versions[lib])) {
    console.error(`generate-importmap: package.json dependencies.${name} must be an exact version, not a range (got "${versions[lib]}")`);
    process.exit(1);
  }
}

// Entry points that must exist for a library to count as locally vendored.
const probes = {
  three: 'three.js/build/three.module.js',
  lilGui: 'node_modules/lil-gui/dist/lil-gui.esm.min.js',
};

const vendor = {};
for (const [lib, entry] of Object.entries(probes)) {
  vendor[lib] = local && existsSync(resolve(ROOT, entry)) ? 'local' : 'cdn';
}

const fail = (msg) => { console.error(`generate-importmap: ${msg}`); process.exit(1); };

/**
 * Subresource-integrity hash of an installed file, in the sha384-<base64> form
 * the importmap `integrity` map takes.
 * @param {string} rel - Path relative to ROOT.
 * @returns {string} The `sha384-…` integrity value.
 */
function integrityOf(rel) {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) {
    fail(`${rel} is missing — run \`npm ci\` before generating the import map`);
  }
  return `sha384-${createHash('sha384').update(readFileSync(path)).digest('base64')}`;
}

/**
 * Assert an installed package is exactly the version the importmap pins, so a
 * stale node_modules cannot bake a hash for bytes the CDN will not serve.
 * @param {string} name - Package directory under node_modules.
 * @param {string} want - The version pinned in package.json.
 */
function requireInstalledVersion(name, want) {
  const manifest = resolve(ROOT, 'node_modules', name, 'package.json');
  if (!existsSync(manifest)) {
    fail(`node_modules/${name} is missing — run \`npm ci\` before generating the import map`);
  }
  const got = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (got !== want) {
    fail(`node_modules/${name} is ${got} but package.json pins ${want} — run \`npm ci\``);
  }
}

// Source files the browser loads, scanned for the three/addons/ modules that
// resolve through the prefix mapping: an integrity map is keyed by exact URL, so
// each addon the app imports needs its own entry.
const SKIP_DIRS = new Set(['node_modules', 'three.js', 'vendor', 'scripts', 'tests', '.github']);

/**
 * Collect every tracked browser-loaded source file.
 * @returns {string[]} Absolute paths of the .js/.html files found.
 */
function collectSources() {
  let listed;
  try {
    listed = execFileSync(
      'git',
      ['-C', ROOT, 'ls-files', '-z', '--', ':(glob)**/*.js', ':(glob)**/*.html'],
      { encoding: 'utf8' },
    );
  } catch {
    fail('git ls-files failed while enumerating browser sources');
  }
  return listed.split('\0')
    .filter(Boolean)
    .filter((path) => !SKIP_DIRS.has(path.split('/')[0]))
    .map((path) => resolve(ROOT, path));
}

/**
 * The three/addons/ module paths the app imports, sorted for a stable diff.
 * @returns {string[]} Paths below `three/examples/jsm/`.
 */
function usedThreeAddons() {
  const found = new Set();
  for (const file of collectSources()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/three\/addons\/([\w./-]+\.js)/g)) found.add(m[1]);
  }
  return [...found].sort();
}

const integrity = { three: '', lilGui: '', threeAddons: {} };
if (vendor.three === 'cdn') {
  requireInstalledVersion('three', versions.three);
  integrity.three = integrityOf('node_modules/three/build/three.module.js');
  for (const addon of usedThreeAddons()) {
    integrity.threeAddons[addon] = integrityOf(`node_modules/three/examples/jsm/${addon}`);
  }
}
if (vendor.lilGui === 'cdn') {
  requireInstalledVersion('lil-gui', versions.lilGui);
  integrity.lilGui = integrityOf('node_modules/lil-gui/dist/lil-gui.esm.min.js');
}

const addonLines = Object.entries(integrity.threeAddons)
  .map(([path, hash]) => `      '${path}': '${hash}',\n`)
  .join('');

const block =
  `  // === GENERATED by scripts/generate-importmap.mjs — do not edit by hand ===\n` +
  `  // Per-library resolution baked at build time. 'cdn' (default, deploy-safe)\n` +
  `  // or 'local' (offline dev with vendored dirs). Versions come from\n` +
  `  // package.json, integrity hashes from the installed node_modules copy of\n` +
  `  // each pinned version. Regenerate, don't hand-edit.\n` +
  `  const VENDOR = { three: '${vendor.three}', lilGui: '${vendor.lilGui}' };\n` +
  `  const THREE_VERSION = '${versions.three}';\n` +
  `  const LIL_GUI_VERSION = '${versions.lilGui}';\n` +
  `  const INTEGRITY = {\n` +
  `    three: '${integrity.three}',\n` +
  `    lilGui: '${integrity.lilGui}',\n` +
  `    threeAddons: {\n` +
  addonLines +
  `    },\n` +
  `  };\n` +
  `  // === END GENERATED ===`;

const src = readFileSync(SOURCE, 'utf8');
const re = /  \/\/ === GENERATED by[\s\S]*?  \/\/ === END GENERATED ===/;
if (!re.test(src)) {
  console.error('generate-importmap: GENERATED VENDOR block not found in vendor-importmap.js');
  process.exit(1);
}
writeFileSync(TARGET, src.replace(re, () => block));

const hashed = (integrity.three ? 1 : 0) + (integrity.lilGui ? 1 : 0)
  + Object.keys(integrity.threeAddons).length;
console.log(`vendor-importmap.js: three=${vendor.three}, lilGui=${vendor.lilGui}, ` +
  `${hashed} integrity hashes` +
  (local ? ' (local mode — do NOT commit a local block)' : ''));
