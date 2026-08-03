import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['lissajous', 'mobius', 'palettes', 'solids'];
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');
const pageSrc = (name) => read('tools', `${name}.html`);
const headOf = (src) => src.slice(src.indexOf('<head>'), src.indexOf('</head>'));

/**
 * Class names a stylesheet defines. Tailwind escapes the characters it allows in
 * a class but not in a selector (`.text-\[0\.65rem\]`), so the backslashes come
 * back out to recover the token as authored.
 * @param {string} css - Stylesheet source.
 * @returns {Set<string>} Defined class names.
 */
const definedClasses = (css) => {
  const names = new Set();
  for (const [, name] of css.matchAll(/\.((?:[\w-]|\\.)+)/g)) {
    names.add(name.replace(/\\/g, ''));
  }
  return names;
};

/**
 * Class tokens a page's static markup references. Inline scripts build markup
 * from template literals, so tokens carrying interpolation or JS punctuation are
 * dropped rather than reported as undefined classes.
 * @param {string} src - Page source.
 * @returns {Set<string>} Referenced class tokens.
 */
const referencedClasses = (src) => {
  const tokens = new Set();
  for (const [, value] of src.matchAll(/class="([^"]*)"/g)) {
    for (const token of value.split(/\s+/)) {
      if (token && !/[${}<>()'"+=?]/.test(token)) tokens.add(token);
    }
  }
  return tokens;
};

test('tool pages load no Tailwind CDN code', () => {
  for (const name of PAGES) {
    const src = pageSrc(name);
    assert.doesNotMatch(src, /cdn\.tailwindcss\.com/,
      `${name}.html still references the Tailwind CDN`);
    assert.doesNotMatch(src, /vendor\/tailwindcss\.js/,
      `${name}.html still loads a vendored Tailwind build`);
  }
});

test('tool page CSPs permit no Tailwind CDN origin', () => {
  for (const name of PAGES) {
    const csp = pageSrc(name).match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
    assert.ok(csp, `${name}.html has no Content-Security-Policy meta`);
    assert.doesNotMatch(csp, /tailwindcss\.com/,
      `${name}.html CSP still allows the Tailwind CDN`);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
  }
});

test('tool pages link tailwind.css last so utilities outrank page rules', () => {
  for (const name of PAGES) {
    const head = headOf(pageSrc(name));
    const links = [...head.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
    assert.ok(links.length > 0, `${name}.html links no stylesheet`);
    const last = links.at(-1);
    assert.match(last[0], /href="tailwind\.css"/,
      `${name}.html must link tailwind.css after every other stylesheet`);
    const lastStyle = head.lastIndexOf('<style');
    assert.ok(lastStyle < last.index,
      `${name}.html inlines a <style> after tailwind.css`);
  }
});

// Classes carried purely as querySelector hooks; nothing styles them.
const BEHAVIOR_HOOKS = new Set([
  'op-param', 'move-op-up', 'move-op-down', 'remove-op-btn',
]);

test('tailwind.css and tools.css define every class the tool pages use', () => {
  const shared = definedClasses(read('tools', 'tailwind.css'));
  for (const name of definedClasses(read('tools', 'tools.css'))) shared.add(name);
  for (const name of BEHAVIOR_HOOKS) shared.add(name);
  for (const name of PAGES) {
    const src = pageSrc(name);
    const defined = new Set(shared);
    for (const [, css] of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      for (const cls of definedClasses(css)) defined.add(cls);
    }
    const missing = [...referencedClasses(src)].filter((c) => !defined.has(c));
    assert.deepEqual(missing, [],
      `${name}.html uses classes no stylesheet defines: ${missing.join(', ')}`);
  }
});

test('tailwind.css keeps its upstream license banner', () => {
  assert.match(read('tools', 'tailwind.css'),
    /! tailwindcss v\d+\.\d+\.\d+ \| MIT License/);
});
