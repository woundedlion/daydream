import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servedPages } from './site_pages.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = servedPages()
  .filter((page) => page.startsWith('tools/'))
  .map((page) => posix.basename(page, '.html'));
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

/**
 * The repo stylesheets a page links. The vendored font sheet lives in the
 * gitignored /vendor/ and is absent from a checkout, so only what exists is
 * collected.
 * @param {string} page - Repo-relative page path.
 * @returns {string[][]} Path segments of each stylesheet.
 */
const sheetsOf = (page) => {
  const found = [];
  for (const [tag] of headOf(read(page)).matchAll(/<link\b[^>]*>/g)) {
    if (!/\brel="stylesheet"/.test(tag)) continue;
    const href = tag.match(/\bhref="([^"]+)"/)?.[1];
    if (!href || href.includes('://')) continue;
    const path = posix.normalize(posix.join(posix.dirname(page), href));
    if (existsSync(join(REPO, path))) found.push(path.split('/'));
  }
  return found;
};

// Every page the app serves, paired with the stylesheets it links. The CSP and
// undefined-class gates run over all of them — index.html is the most-loaded
// page, so it is the one least able to afford being ungated.
const SERVED_PAGES = servedPages().map((page) => ({
  page,
  sheets: sheetsOf(page),
  scripts: scriptsOf(page),
}));

// Each served page's whole script-src, token by token. 'unsafe-inline' covers
// the import map vendor-importmap.js injects and the inline module block each
// tool page carries, so the directive bounds where scripts are fetched from
// rather than what may run inline, and the origin list is the whole of it.
const SCRIPT_SRC = {
  'tools/lissajous.html': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
  'tools/mobius.html': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
  'tools/palettes.html': ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
  'tools/shader.html':
    ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net'],
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
  assert.deepEqual(Object.keys(SCRIPT_SRC).sort(), SERVED_PAGES.map(({ page }) => page).sort(),
    'the committed script-src lists and the served set have drifted apart');
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
 * that links no font stylesheet renders in the system fallback instead. The
 * vendored stylesheet lives in the gitignored /vendor/, so on the deploy the
 * link 404s and only its onerror swap to the CDN copy loads any fonts at all.
 */
test('every tool page links the font families tools.css styles for', () => {
  for (const name of PAGES) {
    const csp = cspOf(`tools/${name}.html`);
    const fontLink = headOf(pageSrc(name))
      .match(/<link\b[^>]*href="\.\.\/vendor\/fonts\/fonts\.css"[^>]*>/)?.[0];
    assert.ok(fontLink, `${name}.html links no font stylesheet`);
    assert.match(fontLink,
      /onerror="this\.onerror=null;this\.href='https:\/\/fonts\.googleapis\.com\/css2\?family=Inter[^']*family=JetBrains\+Mono[^']*'"/,
      `${name}.html font link carries no CDN onerror fallback, so the deploy renders in the system font`);
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
    assert.ok(sheets.length > 0, `${page} links no stylesheet in the repo`);
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

// WCAG 2.1 SC 1.4.3, normal-size text: anything under 18.66px, or under 24px
// and not bold. Every pair below is well inside that.
const AA_CONTRAST = 4.5;

// Text rule -> the tools.css rule that paints the surface it sits on. The
// stylesheet pairs these itself, so nothing about a page can talk either side
// out of the other.
const CONTRAST_PAIRS = [['.slider-label', '.param-group']];

// palettes.html styles its tabs in a <style> of its own. Both label colours sit
// on a fill the same rule declares, so each pair is one selector read twice.
const TAB_CONTRAST_PAIRS = [['.tab-btn', '.tab-btn'], ['.tab-btn.active', '.tab-btn.active']];

/**
 * One rule's declaration block.
 * @param {string} css - Stylesheet text.
 * @param {string} selector - The rule's selector, exactly as written.
 * @returns {string} Everything between its braces.
 */
function ruleBody(css, selector) {
  for (const chunk of css.split('}')) {
    const brace = chunk.indexOf('{');
    if (brace !== -1 && chunk.slice(0, brace).replace(/\/\*[\s\S]*?\*\//g, '').trim() === selector) {
      return chunk.slice(brace + 1);
    }
  }
  return assert.fail(`tools.css declares no ${selector} rule`);
}

/**
 * A property's value, with a single `var()` reference resolved against :root.
 * @param {string} css - Stylesheet text.
 * @param {string} selector - Rule to read.
 * @param {string} property - Property to read.
 * @returns {string} The value, as a `#rrggbb` literal.
 */
function color(css, selector, property) {
  const declared = ruleBody(css, selector)
    .match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  assert.ok(declared, `${selector} declares no ${property}`);
  const value = declared[1].trim();
  const token = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  const resolved = token ? color(css, ':root', token[1]) : value;
  assert.match(resolved, /^#[0-9a-f]{6}$/i,
    `${selector} ${property} resolves to ${resolved}, which this reader cannot measure`);
  return resolved;
}

/**
 * WCAG relative luminance of a `#rrggbb` color.
 * @param {string} hex - The color.
 * @returns {number} Its luminance in [0, 1].
 */
function luminance(hex) {
  const channels = [1, 3, 5].map((at) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * Contrast ratio between one rule's text colour and another's fill.
 * @param {string} css - Stylesheet text.
 * @param {string} text - Rule declaring `color`.
 * @param {string} surface - Rule declaring `background-color`.
 * @returns {number} The WCAG contrast ratio.
 */
function contrast(css, text, surface) {
  const [light, dark] = [color(css, text, 'color'), color(css, surface, 'background-color')]
    .map(luminance).sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Pins the shared control styling to the WCAG AA contrast floor. These rules
 * style the readout of every slider on two tool pages, so a token retuned for
 * looks takes the whole set of them below the floor at once.
 */
test('tools.css control text clears the WCAG AA contrast floor', () => {
  const css = read('tools', 'tools.css');
  for (const [text, surface] of CONTRAST_PAIRS) {
    const ratio = contrast(css, text, surface);
    assert.ok(ratio >= AA_CONTRAST,
      `${text} on ${surface} measures ${ratio.toFixed(2)}:1, under the ${AA_CONTRAST}:1 AA floor`);
  }
});

test('the palettes.html tab controls clear the WCAG AA contrast floor', () => {
  const src = read('tools', 'palettes.html');
  const open = src.indexOf('<style>');
  assert.ok(open >= 0, 'palettes.html must still carry its page styles inline');
  // Read behind tools.css so the page rules' var() references resolve against
  // the token block that defines them.
  const css = read('tools', 'tools.css')
    + src.slice(open + '<style>'.length, src.indexOf('</style>', open));
  for (const [text, surface] of TAB_CONTRAST_PAIRS) {
    const ratio = contrast(css, text, surface);
    assert.ok(ratio >= AA_CONTRAST,
      `${text} measures ${ratio.toFixed(2)}:1, under the ${AA_CONTRAST}:1 AA floor`);
  }
});
