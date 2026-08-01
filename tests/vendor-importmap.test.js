// @ts-check
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(REPO, 'vendor-importmap.js'), 'utf8');

// The committed VENDOR block is all-CDN, so the 'local' variant has to be
// generated. scripts/generate-importmap.mjs is run for real against a throwaway
// fixture repo — rewriting the block here with a regex would silently no-op the
// day the generated block changes shape, misattributing the resulting failures.
const FIXTURE = mkdtempSync(join(tmpdir(), 'vendor-importmap-'));
after(() => rmSync(FIXTURE, { recursive: true, force: true }));

/**
 * Runs the real generator in --local mode against a fixture repo and returns the
 * vendor-importmap.js it produces.
 * @returns {string} The rewritten source, with a locally-resolved VENDOR block.
 */
const generateLocalSrc = () => {
  mkdirSync(join(FIXTURE, 'scripts'), { recursive: true });
  copyFileSync(join(REPO, 'scripts', 'generate-importmap.mjs'),
    join(FIXTURE, 'scripts', 'generate-importmap.mjs'));
  copyFileSync(join(REPO, 'package.json'), join(FIXTURE, 'package.json'));
  copyFileSync(join(REPO, 'vendor-importmap.js'), join(FIXTURE, 'vendor-importmap.js'));
  // --local resolves a library locally only where its vendored entry point exists.
  mkdirSync(join(FIXTURE, 'three.js', 'build'), { recursive: true });
  writeFileSync(join(FIXTURE, 'three.js', 'build', 'three.module.js'), '');
  mkdirSync(join(FIXTURE, 'node_modules', 'lil-gui', 'dist'), { recursive: true });
  writeFileSync(join(FIXTURE, 'node_modules', 'lil-gui', 'dist', 'lil-gui.esm.min.js'), '');
  execFileSync(process.execPath, [join(FIXTURE, 'scripts', 'generate-importmap.mjs'), '--local'],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  return readFileSync(join(FIXTURE, 'vendor-importmap.js'), 'utf8');
};

const LOCAL_SRC = generateLocalSrc();

/**
 * Evaluates the runtime importmap IIFE against a stubbed DOM and returns the
 * whole importmap it injects, from either the committed CDN source or the
 * generated 'local' one.
 * @param {{vendor?: 'cdn'|'local', selfSrc?: string, extra?: Object}} [opts]
 * @returns {Object} The parsed importmap.
 */
const evalImportmapJson = ({ vendor = 'cdn', selfSrc = 'https://example.test/app/vendor-importmap.js', extra } = {}) => {
  const source = vendor === 'local' ? LOCAL_SRC : SRC;
  let injected = null;
  const sandbox = {
    URL,
    console,
    window: extra ? { daydreamExtraImports: extra } : {},
    document: {
      currentScript: { src: selfSrc },
      createElement: () => ({ type: '', textContent: '' }),
      head: { appendChild: (s) => { injected = s; } },
    },
  };
  vm.runInNewContext(source, sandbox);
  assert.ok(injected, 'an importmap <script> was injected');
  assert.equal(injected.type, 'importmap');
  return JSON.parse(injected.textContent);
};

/**
 * The injected importmap's `imports` map.
 * @param {{vendor?: 'cdn'|'local', selfSrc?: string, extra?: Object}} [opts]
 * @returns {Object} The parsed importmap imports map.
 */
const evalImportmap = (opts) => evalImportmapJson(opts).imports;

test('throws a named error when document.currentScript is null', () => {
  const sandbox = { URL, console, window: {}, document: { currentScript: null } };
  assert.throws(() => vm.runInNewContext(SRC, sandbox), /currentScript is null/);
});

test('cdn variant maps three and lil-gui to the jsDelivr CDN', () => {
  const imports = evalImportmap({ vendor: 'cdn' });
  assert.match(imports['three'], /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@[\d.]+\/build\/three\.module\.js$/);
  assert.match(imports['three/addons/'], /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@[\d.]+\/examples\/jsm\/$/);
  assert.match(imports['lil-gui'], /^https:\/\/cdn\.jsdelivr\.net\/npm\/lil-gui@[\d.]+\/dist\/lil-gui\.esm\.min\.js$/);
  assert.equal(imports['gui'], 'https://example.test/app/gui.js');
});

test('local variant resolves three and lil-gui relative to the script path', () => {
  const imports = evalImportmap({ vendor: 'local' });
  assert.equal(imports['three'], 'https://example.test/app/three.js/build/three.module.js');
  assert.equal(imports['three/addons/'], 'https://example.test/app/three.js/examples/jsm/');
  assert.equal(imports['lil-gui'], 'https://example.test/app/node_modules/lil-gui/dist/lil-gui.esm.min.js');
  assert.equal(imports['gui'], 'https://example.test/app/gui.js');
});

test('self-path detection resolves gui.js against the script directory', () => {
  const imports = evalImportmap({ selfSrc: 'https://cdn.example/deep/tools/vendor-importmap.js' });
  assert.equal(imports['gui'], 'https://cdn.example/deep/tools/gui.js');
});

test('cdn variant pins every CDN module with a sha384 integrity entry', () => {
  const map = evalImportmapJson({ vendor: 'cdn' });
  const { imports, integrity } = map;
  assert.ok(integrity, 'an integrity map is emitted alongside imports');

  // The prefix mapping cannot be pinned as a prefix: each addon the app imports
  // needs its own resolved-URL entry.
  const addonBase = imports['three/addons/'];
  const addonKeys = Object.keys(integrity).filter((u) => u.startsWith(addonBase));
  assert.ok(addonKeys.length > 0, 'the three/addons/ modules in use are pinned individually');
  assert.equal(integrity[addonBase], undefined, 'the prefix itself is not a valid integrity key');

  for (const url of [imports['three'], imports['lil-gui'], ...addonKeys]) {
    assert.match(integrity[url], /^sha384-[A-Za-z0-9+/]+=*$/, `${url} carries a sha384 hash`);
  }
  assert.equal(Object.keys(integrity).length, 2 + addonKeys.length,
    'only the CDN modules are pinned');
  assert.equal(integrity[imports['gui']], undefined, 'same-origin gui.js is not pinned');
});

test('local variant emits no integrity map', () => {
  const map = evalImportmapJson({ vendor: 'local' });
  assert.equal(map.integrity, undefined,
    'same-origin vendored modules gain nothing from SRI');
});

test('EXTRA imports are merged but core keys win', () => {
  const imports = evalImportmap({
    extra: { three: 'https://evil.test/hijack.js', helper: './helper.js' },
  });
  assert.match(imports['three'], /cdn\.jsdelivr\.net/, 'core three is not clobbered by EXTRA');
  assert.equal(imports['helper'], './helper.js', 'a non-core EXTRA key is added verbatim');
});
