import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['lissajous', 'mobius', 'palettes', 'solids'];
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');
const pageSrc = (name) => read('tools', `${name}.html`);
const headOf = (src) => src.slice(src.indexOf('<head>'), src.indexOf('</head>'));

// Relative module specifiers, covering `import`, `export … from` and `import()`.
const SPECIFIER = /(?:from|import)\s*\(?\s*['"](\.[^'"]+\.js)['"]/g;

/**
 * The tools/ modules a page ends up loading. The walk follows the app's own
 * modules too, so a tool module a page reaches only through one (index.html
 * pulls the banner via bootstrap.js) is found; only tools/ modules are
 * collected, since the rest carry no shared-stylesheet obligation.
 * @param {string} page - Repo-relative page path.
 * @returns {string[][]} Path segments of each tools/ module, sorted.
 */
const scriptsOf = (page) => {
  const found = new Set();
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !existsSync(join(REPO, file))) return;
    seen.add(file);
    if (posix.dirname(file) === 'tools' && file.endsWith('.js')) found.add(file);
    const src = read(file);
    // A page's own `src` attributes are page-relative; a module specifier is
    // relative only when it says so, and a bare one names a vendored package.
    const specs = file.endsWith('.html')
      ? [...src.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
        .map(([, s]) => s).filter((s) => !s.includes('://'))
      : [];
    for (const [, spec] of src.matchAll(SPECIFIER)) specs.push(spec);
    for (const spec of specs) walk(posix.join(posix.dirname(file), spec));
  };
  walk(page);
  return [...found].sort().map((f) => f.split('/'));
};

// Every page the app serves, paired with the stylesheets it links: the tool
// pages share tools/, index.html has its own. The CSP and undefined-class gates
// run over all of them — index.html is the most-loaded page, so it is the one
// least able to afford being ungated.
const SERVED_PAGES = [
  ...PAGES.map((name) => ({
    page: `tools/${name}.html`,
    sheets: [['tools', 'tailwind.css'], ['tools', 'tools.css']],
  })),
  { page: 'index.html', sheets: [['styles', 'index.css']] },
].map((entry) => ({ ...entry, scripts: scriptsOf(entry.page) }));

// Each served page's whole script-src, token by token. 'unsafe-inline' covers
// the import map vendor-importmap.js injects and the inline module block each
// tool page carries, so the directive bounds where scripts are fetched from
// rather than what may run inline, and the origin list is the whole of it.
const SCRIPT_SRC = {
  'tools/lissajous.html': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
  'tools/mobius.html': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
  'tools/palettes.html': ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
  'tools/solids.html':
    ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net'],
  'index.html':
    ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net'],
};

/**
 * A page's Content-Security-Policy.
 * @param {string} page - Repo-relative page path.
 * @returns {?string} The meta tag's policy, or null where the page carries none.
 */
const cspOf = (page) =>
  read(page).match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] ?? null;

/**
 * One directive's source list.
 * @param {string} csp - Policy text.
 * @param {string} name - Directive name, e.g. 'script-src'.
 * @returns {?string[]} Its tokens in source order, or null where the policy does
 *   not name the directive.
 */
const directive = (csp, name) =>
  csp.split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([d]) => d === name)?.slice(1) ?? null;

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
 * Splits a class attribute value into `tokens`. Inline scripts build markup from
 * template literals, so tokens carrying interpolation or JS punctuation are
 * dropped rather than reported as undefined classes.
 * @param {Set<string>} tokens - Set the tokens are added to.
 * @param {string} value - Whitespace-separated class list.
 * @returns {void}
 */
const addTokens = (tokens, value) => {
  for (const token of value.split(/\s+/)) {
    if (token && !/[${}<>()'"+=?]/.test(token)) tokens.add(token);
  }
};

/**
 * Class tokens a page's static markup references.
 * @param {string} src - Page source.
 * @returns {Set<string>} Referenced class tokens.
 */
const referencedClasses = (src) => {
  const tokens = new Set();
  for (const [, value] of src.matchAll(/class="([^"]*)"/g)) addTokens(tokens, value);
  return tokens;
};

/**
 * Class tokens a script puts on the elements it builds. Reads the three forms
 * the tool modules use — `className =`, `classList.add`/`toggle`, and the
 * `…Class`/`…Classes` options a caller can override — each of which names its
 * value as a class list; a class assembled some other way (passed positionally,
 * built by interpolation) is out of reach and simply goes ungated.
 * @param {string} src - Script source.
 * @returns {Set<string>} Referenced class tokens.
 */
const scriptClasses = (src) => {
  const tokens = new Set();
  const literals = (s) => [...s.matchAll(/(['"`])([^'"`]*)\1/g)].map(([, , v]) => v);
  for (const [, , value] of src.matchAll(/\.className\s*=\s*(['"`])([^'"`]*)\1/g)) {
    addTokens(tokens, value);
  }
  for (const [, method, args] of src.matchAll(/\.classList\.(add|toggle)\(([^)]*)\)/g)) {
    // toggle's second argument is a force flag, not a class.
    const values = literals(args);
    for (const value of method === 'toggle' ? values.slice(0, 1) : values) {
      addTokens(tokens, value);
    }
  }
  for (const [, binding] of src.matchAll(
    /\b\w*[Cc]lass(?:es)?\s*[:=]\s*(\[[^\]]*\]|(['"`])[^'"`]*\2)/g)) {
    for (const value of literals(binding)) addTokens(tokens, value);
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

test('every served page carries a CSP permitting no Tailwind CDN origin or blanket eval', () => {
  for (const { page } of SERVED_PAGES) {
    const csp = cspOf(page);
    assert.ok(csp, `${page} has no Content-Security-Policy meta`);
    assert.doesNotMatch(csp, /tailwindcss\.com/,
      `${page} CSP still allows the Tailwind CDN`);
    // The quote is what separates the two tokens: 'wasm-unsafe-eval', which
    // WebAssembly.instantiate needs, does not match.
    assert.doesNotMatch(csp, /'unsafe-eval'/,
      `${page} CSP grants blanket 'unsafe-eval'; instantiating WASM needs only 'wasm-unsafe-eval'`);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
  }
});

/**
 * Pins each served page's script-src to its exact token list. `default-src`
 * alone leaves the directive that actually decides where scripts load from
 * ungated, so an origin added to any page passes CI on the strength of a
 * default it overrides.
 */
test('every served page\'s script-src is exactly its committed token list', () => {
  for (const { page } of SERVED_PAGES) {
    const want = SCRIPT_SRC[page];
    assert.ok(want, `${page} has no committed script-src token list`);
    const tokens = directive(cspOf(page), 'script-src');
    assert.ok(tokens, `${page} CSP declares no script-src of its own`);
    assert.deepEqual([...tokens].sort(), [...want].sort(),
      `${page} script-src drifted from its committed token list`);
  }
});

/**
 * tools.css names Inter and JetBrains Mono for every page it styles, so a page
 * that links no font stylesheet renders in the system fallback instead.
 */
test('every tool page links the font families tools.css styles for', () => {
  for (const name of PAGES) {
    const csp = cspOf(`tools/${name}.html`);
    assert.match(headOf(pageSrc(name)), /<link\b[^>]*href="\.\.\/vendor\/fonts\/fonts\.css"/,
      `${name}.html links no font stylesheet`);
    assert.ok(directive(csp, 'style-src').includes('https://fonts.googleapis.com'),
      `${name}.html CSP blocks the font stylesheet's CDN fallback`);
    assert.ok(directive(csp, 'font-src').includes('https://fonts.gstatic.com'),
      `${name}.html CSP blocks the fallback font files`);
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

// Classes carried purely as querySelector hooks; nothing styles them. The
// banner's two are inline-styled on purpose — it has to render on a page whose
// stylesheet is what failed.
const BEHAVIOR_HOOKS = new Set([
  'op-param', 'move-op-up', 'move-op-down', 'remove-op-btn',
  'fatal-error-message', 'fatal-error-dismiss',
]);

test('every served page\'s stylesheets define every class it uses', () => {
  for (const { page, sheets, scripts } of SERVED_PAGES) {
    const src = read(page);
    const defined = new Set(BEHAVIOR_HOOKS);
    for (const sheet of sheets) {
      for (const name of definedClasses(read(...sheet))) defined.add(name);
    }
    for (const [, css] of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      for (const cls of definedClasses(css)) defined.add(cls);
    }
    // tailwind.css is committed prebuilt with no config or build step, so a
    // utility a script reaches for that no rule defines stays silently unstyled.
    const sources = [[page, referencedClasses(src)],
      ...scripts.map((s) => [s.join('/'), scriptClasses(read(...s))])];
    for (const [source, tokens] of sources) {
      const missing = [...tokens].filter((c) => !defined.has(c));
      assert.deepEqual(missing, [],
        `${source} uses classes no stylesheet ${page} loads defines: ${missing.join(', ')}`);
    }
  }
});

test('every tools/ module that sets a class is reached from a served page', () => {
  const gated = new Set(
    SERVED_PAGES.flatMap(({ scripts }) => scripts.map((s) => s.join('/'))));
  for (const file of readdirSync(join(REPO, 'tools')).filter((f) => f.endsWith('.js'))) {
    const path = `tools/${file}`;
    if (scriptClasses(read(path)).size === 0) continue;
    assert.ok(gated.has(path),
      `${path} sets classes but no served page's module graph reaches it, so nothing gates them`);
  }
});

test('tailwind.css keeps its upstream license banner', () => {
  assert.match(read('tools', 'tailwind.css'),
    /! tailwindcss v\d+\.\d+\.\d+ \| MIT License/);
});
