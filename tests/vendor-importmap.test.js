// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../vendor-importmap.js', import.meta.url), 'utf8');

/**
 * Evaluates the runtime importmap IIFE against a stubbed DOM and returns the
 * `imports` map it injects. The baked VENDOR block is rewritten to exercise the
 * 'local' variant (the committed default is all-CDN).
 * @param {{vendor?: 'cdn'|'local', selfSrc?: string, extra?: Object}} [opts]
 * @returns {Object} The parsed importmap imports map.
 */
const evalImportmap = ({ vendor = 'cdn', selfSrc = 'https://example.test/app/vendor-importmap.js', extra } = {}) => {
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
  return JSON.parse(injected.textContent).imports;
};

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

test('EXTRA imports are merged but core keys win', () => {
  const imports = evalImportmap({
    extra: { three: 'https://evil.test/hijack.js', helper: './helper.js' },
  });
  assert.match(imports['three'], /cdn\.jsdelivr\.net/, 'core three is not clobbered by EXTRA');
  assert.equal(imports['helper'], './helper.js', 'a non-core EXTRA key is added verbatim');
});
