/*
 * Generates the local/CDN decisions, package.json version pins and sha384 hashes
 * in the offline vendor-importmap.js model and static page import maps/CSP hashes.
 * Hashes require matching pinned packages installed in node_modules.
 *
 *   node scripts/generate-importmap.mjs            # all-CDN (default)
 *   node scripts/generate-importmap.mjs --local    # local entry points present, else CDN
 *   node scripts/generate-importmap.mjs --out F    # alternate model output
 *   node scripts/generate-importmap.mjs --pages-root D  # alternate page output root
 *   node scripts/generate-importmap.mjs --vendor-root D  # vendored entry-point probe root
 *   node scripts/generate-importmap.mjs --root D   # package and tracked-import source root
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, posix } from 'node:path';
import { parse } from 'espree';
import { vendorAddonsFromSource } from './vendor-imports.mjs';

const rootIndex = process.argv.indexOf('--root');
const rootPath = rootIndex === -1
  ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : process.argv[rootIndex + 1];
if (rootPath === undefined || rootPath.startsWith('--')) {
  console.error('generate-importmap: --root requires a path');
  process.exit(1);
}
const ROOT = resolve(rootPath);
const SOURCE = resolve(ROOT, 'vendor-importmap.js');

const local = process.argv.includes('--local');
const outIndex = process.argv.indexOf('--out');
const TARGET = outIndex === -1 ? SOURCE : process.argv[outIndex + 1];
if (TARGET === undefined || TARGET.startsWith('--')) {
  console.error('generate-importmap: --out requires a path');
  process.exit(1);
}
const vendorIndex = process.argv.indexOf('--vendor-root');
const VENDOR_ROOT = vendorIndex === -1 ? ROOT : process.argv[vendorIndex + 1];
if (VENDOR_ROOT === undefined || VENDOR_ROOT.startsWith('--')) {
  console.error('generate-importmap: --vendor-root requires a path');
  process.exit(1);
}

const pagesIndex = process.argv.indexOf('--pages-root');
const PAGES_ROOT = pagesIndex === -1 ? ROOT : process.argv[pagesIndex + 1];
if (PAGES_ROOT === undefined || PAGES_ROOT.startsWith('--')) {
  console.error('generate-importmap: --pages-root requires a path');
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
  vendor[lib] = local && existsSync(resolve(VENDOR_ROOT, entry)) ? 'local' : 'cdn';
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
 * @returns {string[]} Absolute paths of the .js/.mjs/.html files found.
 */
function collectSources() {
  let listed;
  try {
    listed = execFileSync(
      'git',
      [
        '-C', ROOT, 'ls-files', '-z', '--',
        ':(glob)**/*.js', ':(glob)**/*.mjs', ':(glob)**/*.html',
      ],
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
    for (const addon of vendorAddonsFromSource(src, file)) found.add(addon);
  }
  return [...found].sort();
}

const integrity = { three: '', lilGui: '', threeAddons: {}, threeFiles: {} };
if (vendor.three === 'cdn') {
  requireInstalledVersion('three', versions.three);
  integrity.three = integrityOf('node_modules/three/build/three.module.js');
  for (const addon of usedThreeAddons()) {
    integrity.threeAddons[addon] = integrityOf(`node_modules/three/examples/jsm/${addon}`);
  }
  const pending = ['build/three.module.js', ...Object.keys(integrity.threeAddons)
    .map((path) => `examples/jsm/${path}`)];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const ast = parse(readFileSync(resolve(ROOT, 'node_modules/three', path), 'utf8'),
      { ecmaVersion: 'latest', sourceType: 'module' });
    for (const node of ast.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) continue;
      const specifier = node.source?.value;
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue;
      const dependency = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (dependency.startsWith('../')) fail(`Three import escapes its package: ${specifier}`);
      integrity.threeFiles[dependency] = integrityOf(`node_modules/three/${dependency}`);
      pending.push(dependency);
    }
  }
}
if (vendor.lilGui === 'cdn') {
  requireInstalledVersion('lil-gui', versions.lilGui);
  integrity.lilGui = integrityOf('node_modules/lil-gui/dist/lil-gui.esm.min.js');
}

const addonLines = Object.entries(integrity.threeAddons)
  .map(([path, hash]) => `      '${path}': '${hash}',\n`)
  .join('');
const fileLines = Object.entries(integrity.threeFiles).sort(([a], [b]) => a.localeCompare(b))
  .map(([path, hash]) => `      '${path}': '${hash}',\n`).join('');

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
  `    threeFiles: {\n` +
  fileLines +
  `    },\n` +
  `  };\n` +
  `  // === END GENERATED ===`;

const src = readFileSync(SOURCE, 'utf8');
const re = / {2}\/\/ === GENERATED by[\s\S]*? {2}\/\/ === END GENERATED ===/;
if (!re.test(src)) {
  console.error('generate-importmap: GENERATED VENDOR block not found in vendor-importmap.js');
  process.exit(1);
}
writeFileSync(TARGET, src.replace(re, () => block));

const hashed = (integrity.three ? 1 : 0) + (integrity.lilGui ? 1 : 0)
  + Object.keys(integrity.threeAddons).length + Object.keys(integrity.threeFiles).length;
console.log(`vendor-importmap.js: three=${vendor.three}, lilGui=${vendor.lilGui}, ` +
  `${hashed} integrity hashes` +
  (local ? ' (local mode — do NOT commit a local block)' : ''));

/**
 * Writes a page's static import map and its exact CSP hash.
 * @param {string} sourcePath Source page under ROOT.
 * @returns {void}
 */
function writePageImportmap(sourcePath) {
  const page = relative(ROOT, sourcePath).replaceAll('\\', '/');
  const target = resolve(PAGES_ROOT, page);
  const source = readFileSync(sourcePath, 'utf8');
  const loader = /<script\b[^>]*\bsrc=["'][^"']*vendor-importmap\.js["'][^>]*><\/script>/;
  const embedded = /<script\b[^>]*\btype=["']importmap["'][^>]*>[\s\S]*?<\/script>/;
  if (!loader.test(source) && !embedded.test(source)) return;
  const prefix = (posix.relative(posix.dirname(page), '.') || '.') + '/';
  const cdn = 'https://cdn.jsdelivr.net';
  const threeCdn = `${cdn}/npm/three@${versions.three}/`;
  const guiCdn = `${cdn}/npm/lil-gui@${versions.lilGui}/`;
  const threeBase = vendor.three === 'local' ? `${prefix}three.js/` : threeCdn;
  const guiBase = vendor.lilGui === 'local' ? `${prefix}node_modules/lil-gui/` : guiCdn;
  const gui = `${guiBase}dist/lil-gui.esm.min.js`;
  const imports = {
    three: `${threeBase}build/three.module.js`,
    'three/addons/': `${threeBase}examples/jsm/`,
    'lil-gui': gui,
  };
  const hashes = {};
  if (vendor.three === 'cdn') {
    hashes[imports.three] = integrity.three;
    for (const [path, hash] of Object.entries(integrity.threeAddons))
      hashes[`${threeBase}examples/jsm/${path}`] = hash;
    for (const [path, hash] of Object.entries(integrity.threeFiles))
      hashes[`${threeBase}${path}`] = hash;
  }
  if (vendor.lilGui === 'cdn') hashes[gui] = integrity.lilGui;
  const map = Object.keys(hashes).length ? { imports, integrity: hashes } : { imports };
  const body = JSON.stringify(map);
  const hash = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
  let output = source.replace(loader.test(source) ? loader : embedded,
    () => `<script type="importmap">${body}</script>`);
  const policy = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/;
  if (!policy.test(output)) fail(`${page} has no Content-Security-Policy`);
  output = output.replace(policy, (_, before, content, after) => {
    const directives = content.split(';');
    const scriptIndex = directives.findIndex(value => /^\s*script-src\s/.test(value));
    if (scriptIndex < 0) fail(`${page} has no script-src directive`);
    const tokens = directives[scriptIndex].trim().split(/\s+/)
      .filter(value => value !== "'unsafe-inline'" && !value.startsWith("'sha256-")
        && value !== cdn && value !== `${cdn}/`
        && !value.startsWith(`${cdn}/npm/three@`) && !value.startsWith(`${cdn}/npm/lil-gui@`));
    if (vendor.three === 'cdn') tokens.push(threeCdn);
    if (vendor.lilGui === 'cdn') tokens.push(guiCdn);
    tokens.push(hash);
    directives[scriptIndex] = ' ' + tokens.join(' ');
    return before + directives.join(';') + after;
  });
  writeFileSync(target, output.replaceAll('\r\n', '\n'));
}

if (outIndex === -1 || pagesIndex !== -1) {
  for (const page of collectSources().filter(path => path.endsWith('.html')))
    writePageImportmap(page);
}
