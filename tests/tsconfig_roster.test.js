// Check the noResolve typecheck roster against pipeline imports, @ts-check files
// and eligible src/ modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

// Engine-installed Emscripten glue and shader compiler are checked upstream.
// The glue import resolves through its hand-written .d.ts sibling.
const NOT_CHECKED = new Set([
  'generated/holosphere_wasm.js', 'generated/shader/shader_workbench.mjs',
  'generated/shader/composed_effect_roster.mjs',
]);

// Never entered: dependency and git metadata, the linked worktrees, the vendored
// third-party drops, the engine checkout, and tests/, which tsconfig.json puts
// out of scope.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.worktrees', 'vendor', 'three.js', 'tests', 'engine',
]);

/**
 * Reads both typecheck configs, accepting whole-line comments in tsconfig.json.
 * @returns {Object} The parsed config.
 */
function readTsconfig() {
  const text = readFileSync(new URL('tsconfig.json', ROOT), 'utf8');
  const stripped = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const config = JSON.parse(stripped);
  const scripts = JSON.parse(readFileSync(new URL('tsconfig.scripts.json', ROOT), 'utf8'));
  config.files.push(...scripts.files);
  return config;
}

// Relative module specifiers, covering `import`, `export … from`, a bare
// side-effect `import`, and the parenthesized form both `import()` and a JSDoc
// `@typedef {import('./x.js').T}` use.
const SPECIFIER = /\b(?:(?:from|import)\s*\(?|new\s+Worker\s*\(\s*new\s+URL\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g;

/**
 * The relative-module specifiers one file imports, resolved against the
 * importing file's directory.
 * @param {string} file - Repo-relative module path.
 * @returns {string[]} Imported module paths, repo-relative.
 */
function importsOf(file) {
  const importer = new URL(file, ROOT);
  const source = readFileSync(importer, 'utf8');
  const found = [];
  for (const [, spec] of source.matchAll(SPECIFIER)) {
    found.push(new URL(spec, importer).href.slice(ROOT.href.length));
  }
  return found;
}

/**
 * Every module reachable from the roster, the roster included.
 * @param {string[]} roster - tsconfig.json's `files`.
 * @returns {Set<string>} The transitive closure, minus what is not checked.
 */
function reachableFrom(roster) {
  const seen = new Set();
  const queue = [...roster];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || NOT_CHECKED.has(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file));
  }
  return seen;
}

/**
 * Every in-scope source carrying a `// @ts-check` pragma.
 * @param {string} dir - Repo-relative directory, '' for the root.
 * @returns {string[]} Repo-relative module paths.
 */
function pragmaFilesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      if (dir !== '' || !SKIP_DIRS.has(entry.name)) found.push(...pragmaFilesUnder(`${path}/`));
    } else if (/\.m?js$/.test(entry.name) && !NOT_CHECKED.has(path)) {
      if (/^\s*\/\/\s*@ts-check\s*$/m.test(readFileSync(new URL(path, ROOT), 'utf8'))) {
        found.push(path);
      }
    }
  }
  return found;
}

test('every module the typecheck roster reaches is itself on the roster', () => {
  const roster = readTsconfig().files;
  const missing = [...reachableFrom(roster)].filter((f) => !roster.includes(f));

  assert.deepEqual(missing, [],
    'an unlisted module is silently `any` under noResolve — add it to '
    + 'tsconfig.json "files" or the typecheck stops seeing its types');
});

test('every `// @ts-check` module is on the typecheck roster', () => {
  const roster = readTsconfig().files;
  const inert = pragmaFilesUnder('').filter((f) => !roster.includes(f));

  assert.deepEqual(inert, [],
    'the pragma only bites on a file tsc actually compiles — add it to '
    + 'tsconfig.json "files" or drop the pragma, which otherwise reads as '
    + 'coverage the file does not have');
});

test('the typecheck roster lists no module that has gone away', () => {
  for (const file of readTsconfig().files) {
    assert.ok(existsSync(fileURLToPath(new URL(file, ROOT))),
      `tsconfig.json "files" lists ${file}, which no longer exists`);
  }
});

test('the typecheck checks nullability and implicit any', () => {
  const options = readTsconfig().compilerOptions;
  assert.equal(options.strictNullChecks, true,
    'the roster exists to catch drift in the postMessage payloads; with '
    + 'strictNullChecks off a null field reads as its own type and nothing trips');
  assert.equal(options.noImplicitAny, true,
    'an unannotated parameter degrades to `any` and stops checking its callers');
});

test('every not-checked module has a declaration file on the roster', () => {
  const roster = readTsconfig().files;
  for (const file of NOT_CHECKED) {
    const declaration = file.endsWith('.mjs')
      ? file.replace(/\.mjs$/, '.d.mts') : file.replace(/\.js$/, '.d.ts');
    assert.ok(roster.includes(declaration),
      `${file} is exempt from the typecheck but a rostered module imports it; `
      + `without ${declaration} on tsconfig.json "files" the import is an `
      + 'unresolved-module error under noResolve, not a silent `any`');
    assert.ok(existsSync(fileURLToPath(new URL(declaration, ROOT))),
      `tsconfig.json "files" lists ${declaration}, which does not exist`);
  }
});

const TOOL_PAGE_EXEMPTIONS = {
  'src/workbench/lissajous/lissajous_page.js': 'Imports Three.js and builds a dynamic DOM controller without declared element types.',
  'src/workbench/mobius/mobius_page.js': 'Imports Three.js and builds a dynamic DOM controller without declared element types.',
  'src/workbench/palettes/palettes_page.js': 'DOM element narrowing and callback parameter annotations are incomplete; it has no third-party import exemption.',
  'src/workbench/solids/solids_page.js': 'Imports Three.js and builds dynamic mesh-editing controls without declared element types.',
};

test('tool page exemptions name existing unrostered modules with reasons', () => {
  const roster = readTsconfig().files;
  for (const [file, reason] of Object.entries(TOOL_PAGE_EXEMPTIONS)) {
    assert.ok(existsSync(new URL(file, ROOT)), `${file} must exist`);
    assert.ok(!roster.includes(file), `${file} exemption is stale`);
    assert.ok(reason.trim().length > 0, `${file} needs a reason`);
  }
});

test('the typecheck roster stays inside its stated scope', () => {
  for (const file of readTsconfig().files) {
    assert.ok(!file.startsWith('tests/'),
      `tsconfig.json "files" lists ${file}: tests/ is deliberately out of scope`);
    assert.ok(!NOT_CHECKED.has(file),
      `tsconfig.json "files" lists ${file}, which is a generated install output`);
  }
});

const SOURCE_EXEMPTIONS = {
  'src/workbench/shared.js': 'Imports Three.js and its renderer addons, whose types are unavailable under noResolve.',
  'scripts/browser-smoke.mjs': 'Browser automation entry point; browser harness types are not yet declared.',
  'scripts/browser.mjs': 'Browser discovery and launch helpers require typed Puppeteer options.',
  'scripts/check-cdn-integrity.mjs': 'Standalone CDN network diagnostic outside deployment staging.',
  'scripts/generate-importmap.mjs': 'Generated import-map writer validated by output parity tests.',
  'scripts/lissajous-probe.mjs': 'Browser probe callbacks require DOM element narrowing.',
  'scripts/mobius-probe.mjs': 'Browser probe callbacks require DOM element narrowing.',
  'scripts/palettes-probe.mjs': 'Browser probe callbacks require DOM element narrowing.',
  'scripts/panel-probe.mjs': 'Browser probe callbacks require DOM element narrowing.',
  'scripts/probe_harness.mjs': 'Shared browser probe harness needs Puppeteer callback types.',
  'scripts/record-module-loads.mjs': 'Node loader hook checked through test discovery integration.',
  'scripts/require-tests.mjs': 'Test-discovery bootstrap outside deployment staging.',
  'scripts/run-tests.mjs': 'Test runner wrapper outside deployment staging.',
  'scripts/serve-manifest.mjs': 'Development server request handlers lack Node annotations.',
  'scripts/site-pages.mjs': 'Publication roster wrapper has no typed public arguments.',
  'scripts/solids-probe.mjs': 'Browser probe callbacks require DOM element narrowing.',
  'scripts/vendor-imports.mjs': 'Import parser helpers require AST node types.',
  'scripts/vendor-stage.mjs': 'Browser fixture staging uses untyped import parser helpers.',
  'scripts/verify-ci-green.mjs': 'GitHub check polling uses untyped response objects.',
  'scripts/workbench-probe.mjs': 'Browser probe callbacks require DOM element narrowing.',
  'src/app/bootstrap.js': 'Imports daydream.js and its untyped Three.js and lil-gui dependencies.',
  'src/app/daydream.js': 'Application composition depends on driver.js and gui.js, whose third-party types are unavailable under noResolve.',
  'src/renderer/driver.js': 'Imports Three.js and its renderer addons, whose types are unavailable under noResolve.',
  'src/renderer/geometry.js': 'Imports Three.js, whose types are unavailable under noResolve.',
  'src/ui/gui.js': 'Imports lil-gui, whose declarations are unavailable under noResolve.',
  'src/app/main.js': 'Imports bootstrap.js, which reaches the untyped application composition.',
  'vendor-importmap.js': 'Generated script-tag IIFE; its source and generated variants are checked by vendor-importmap.test.js.',
};

test('every source module is typechecked or has a written exemption', () => {
  const roster = readTsconfig().files;
  const modules = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name) && entry.name !== 'eslint.config.mjs')
    .map((entry) => entry.name);
  const collect = (directory) => {
    for (const entry of readdirSync(new URL(directory, ROOT), { withFileTypes: true })) {
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory()) collect(`${path}/`);
      else if (/\.m?js$/.test(entry.name)) modules.push(path);
    }
  };
  collect('src/');
  collect('scripts/');
  const exemptions = { ...SOURCE_EXEMPTIONS, ...TOOL_PAGE_EXEMPTIONS };
  assert.deepEqual(modules.filter((file) => !roster.includes(file)).sort(),
    Object.keys(exemptions).sort(),
    'add each source module to tsconfig.json or explain its exemption; remove stale exemptions');
  for (const reason of Object.values(exemptions)) assert.ok(reason.trim().length > 0);
});
