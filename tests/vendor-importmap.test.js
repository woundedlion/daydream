// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../vendor-importmap.js', import.meta.url), 'utf8');

/**
 * Evaluates the runtime importmap IIFE against a stubbed DOM and returns the
 * whole importmap it injects. The baked VENDOR block is rewritten to exercise
 * the 'local' variant (the committed default is all-CDN).
 * @param {{vendor?: 'cdn'|'local', selfSrc?: string, extra?: Object}} [opts]
 * @returns {Object} The parsed importmap.
 */
const evalImportmapJson = ({ vendor = 'cdn', selfSrc = 'https://example.test/app/vendor-importmap.js', extra } = {}) => {
  let source = SRC;
  if (vendor === 'local') {
    source = source.replace(/const VENDOR = \{[^}]*\};/,
      "const VENDOR = { three: 'local', lilGui: 'local' };");
  }
  let injected = null;
  const sandbox = {
    URL,
    console,
    window: extra ? { __DAYDREAM_EXTRA_IMPORTS: extra } : {},
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
