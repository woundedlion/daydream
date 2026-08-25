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

test('every tool page inherits the reduced-motion stylesheet fence', () => {
  const css = read('tools', 'tools.css');
  assert.match(css,
    /@media \(prefers-reduced-motion: reduce\) \{[^{}]*\{[^{}]*animation: none !important;[^{}]*transition: none !important;/);
  for (const page of PAGES)
    assert.match(headOf(pageSrc(page)), /href="tools\.css"/, page);
});

test('the solids rotation control is keyboard-operable', () => {
  const source = pageSrc('solids');
  assert.match(source,
    /<label id="toggleRotateLabel" for="toggleRotate"[^>]*>Auto Rotate<\/label>/);
  assert.match(source,
    /<button id="toggleRotate" type="button"[^>]*role="switch"[^>]*aria-checked="false"/);
});

// A button's accessible name comes from aria-labelledby, aria-label, its own
// text subtree or its title — never from a <label for>. These carry a knob div
// and no text, so without the association all seven announce as unnamed.
test('every solids visualization switch carries an accessible name', () => {
  const source = pageSrc('solids');
  const switches = [...source.matchAll(/<button\b[^>]*role="switch"[^>]*>/g)]
    .map(([tag]) => tag);
  assert.equal(switches.length, 7);
  for (const tag of switches) {
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    const labelledBy = tag.match(/\baria-labelledby="([^"]+)"/)?.[1];
    assert.ok(labelledBy, `${id} announces as an unnamed switch`);
    const label = new RegExp(
      `<label id="${labelledBy}" for="${id}"[^>]*>([^<]+)</label>`).exec(source);
    assert.ok(label, `${labelledBy} names no label of ${id}`);
    assert.ok(label[1].trim().length > 0, `${labelledBy} carries no text`);
  }
});

// Relative module specifiers, covering `import`, `export … from` and `import()`.
const SPECIFIER = /(?:from|import)\s*\(?\s*['"](\.[^'"]+\.js)['"]/g;

/**
 * The modules a page ends up loading, its own and the tools/ ones alike. The
 * walk follows every relative specifier, so a module a page reaches only
 * through another (index.html pulls the banner via bootstrap.js) is found.
 * @param {string} page - Repo-relative page path.
 * @returns {string[][]} Path segments of each module, sorted.
 */
const scriptsOf = (page) => {
  const found = new Set();
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !existsSync(join(REPO, file))) return;
    seen.add(file);
    if (file.endsWith('.js')) found.add(file);
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
// the import map vendor-importmap.js injects; the directive bounds where the
// external controllers are fetched from, and the origin list is the whole of it.
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
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, name] of source.matchAll(/\.((?:[\w-]|\\.)+)/g)) {
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
 * The text between a call's parentheses.
 * @param {string} src - Script source.
 * @param {number} open - Index of the call's opening parenthesis.
 * @returns {string} The argument text, empty where the call never closes.
 */
const callArgs = (src, open) => {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return '';
      i = end;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
};

/**
 * Class tokens a script puts on the elements it builds. Reads the four forms
 * the tool modules use — `className =`, `classList.add`/`toggle`, the
 * `…Class`/`…Classes` options a caller can override, and the class argument
 * of an `el(tag, classes)` builder — each of which names its value as a
 * class list; a class assembled some other way (passed positionally, built by
 * interpolation) is out of reach and simply goes ungated.
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
  // An `el(tag, classes)` builder assigns a variable, which the className
  // form above cannot read; the class list is the call's second argument.
  for (const match of src.matchAll(/\bel\(\s*(['"`])[a-z]+\1\s*,/g)) {
    for (const value of literals(callArgs(src, match.index + 2)).slice(1)) {
      addTokens(tokens, value);
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

test('tool page controllers are external modules', () => {
  for (const name of PAGES) {
    const src = pageSrc(name);
    assert.match(src, /<script\b[^>]*\btype="module"[^>]*\bsrc="[^"]+"[^>]*>/,
      `${name}.html has no external module controller`);
    assert.doesNotMatch(src,
      /<script\b(?=[^>]*\btype="module")(?![^>]*\bsrc=)[^>]*>/,
      `${name}.html keeps its module controller inline`);
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
 * Every served page forbids form submission. `default-src` does not cover
 * `form-action`, and a meta-delivered policy is the only vehicle these pages
 * have: GitHub Pages serves no response headers of their own, which is also why
 * `frame-ancestors` is absent -- it is stripped from a meta policy.
 */
test('every served page CSP forbids form submission', () => {
  for (const { page } of SERVED_PAGES) {
    const csp = cspOf(page);
    assert.deepEqual(directive(csp, 'form-action'), ["'none'"],
      `${page} CSP leaves form-action open`);
    assert.equal(directive(csp, 'frame-ancestors'), null,
      `${page} CSP declares frame-ancestors, which a meta policy drops`);
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

// Behavior-only hooks need no stylesheet. The banner's two are inline-styled
// because it has to render when a page stylesheet fails. The chain strip's undo
// and redo are painted by `.chain-strip-actions button`, its replace options by
// the <select> around them, and --stage is the chip look --socket departs from.
const CLASS_EXEMPTIONS = new Set([
  'op-param', 'move-op-up', 'move-op-down', 'remove-op-btn',
  'fatal-error-message', 'fatal-error-dismiss',
  'chain-undo', 'chain-redo', 'chain-chip-replace-option', 'chain-chip--stage',
]);

// daydream.js loads the shader-document graph on both simulator pages, but it
// creates the chain strip only in the shader-workbench mode.
const NON_RENDERING_CLASS_SOURCES = new Map([
  ['index.html', new Set(['tools/chain_strip.js'])],
]);

const classSourcesFor = ({ page, scripts }) => scripts
  .map((segments) => segments.join('/'))
  .filter((source) => !NON_RENDERING_CLASS_SOURCES.get(page)?.has(source));

test('every served page\'s stylesheets define every class it uses', () => {
  for (const { page, sheets, scripts } of SERVED_PAGES) {
    const src = read(page);
    assert.ok(sheets.length > 0, `${page} links no stylesheet in the repo`);
    const defined = new Set(CLASS_EXEMPTIONS);
    for (const sheet of sheets) {
      for (const name of definedClasses(read(...sheet))) defined.add(name);
    }
    for (const [, css] of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      for (const cls of definedClasses(css)) defined.add(cls);
    }
    // tailwind.css is committed prebuilt with no config or build step, so a
    // utility a script reaches for that no rule defines stays silently unstyled.
    const sources = [[page, referencedClasses(src)],
      ...classSourcesFor({ page, scripts })
        .map((source) => [source, scriptClasses(read(source))])];
    for (const [source, tokens] of sources) {
      const missing = [...tokens].filter((c) => !defined.has(c));
      assert.deepEqual(missing, [],
        `${source} uses classes no stylesheet ${page} loads defines: ${missing.join(', ')}`);
    }
  }
});

// A module that builds no element carries no class. Skipping on a token yield
// of zero instead would excuse exactly the modules whose classes are unreadable.
const BUILDS_ELEMENTS = /\bcreateElement\(|\.className\b|\.classList\b/;

test('every tools/ module that builds an element can render on a served page', () => {
  const gated = new Set(SERVED_PAGES.flatMap(classSourcesFor));
  for (const file of readdirSync(join(REPO, 'tools')).filter((f) => f.endsWith('.js'))) {
    const path = `tools/${file}`;
    if (!BUILDS_ELEMENTS.test(read(path))) continue;
    assert.ok(gated.has(path),
      `${path} builds elements but no served page renders it, so nothing gates its classes`);
  }
});

test('tailwind.css keeps its upstream license banner', () => {
  assert.match(read('tools', 'tailwind.css'),
    /! tailwindcss v\d+\.\d+\.\d+ \| MIT License/);
});

// WCAG 2.1 SC 1.4.3, normal-size text: anything under 18.66px, or under 24px
// and not bold. Every rule swept below is well inside that.
const AA_CONTRAST = 4.5;

// Sheet -> text rule -> the rule painting the surface under it, front to back
// where the nearer fill is translucent. Every rule a tools/ stylesheet declares
// `color` on is listed here or in CONTRAST_EXEMPT, so a colour added to a sheet
// is measured instead of joining the gate unread. tailwind.css is a vendored
// prebuilt drop: its rules stay in the cascade but out of the sweep.
const CONTRAST_SURFACES = {
  'tools.css': {
    'body': 'body',
    '.slider-label': '.param-group',
    '.btn-primary': '.btn-primary',
    '.btn-secondary': '.btn-secondary',
  },
  'mobius.css': {
    '.preset-btn': '.preset-btn',
    '.preset-desc': '.preset-btn',
    '.complex-plane-label': '.param-group',
  },
  'palettes.css': {
    '#gen_status': '.tab-content',
    '.recipe-preset': '.recipe-preset',
    '.recipe-preset-select': '.recipe-preset-select',
    '.recipe-field > label': '.param-group',
    '.wave-legend': '.param-group',
    '.export-trigger': '.export-trigger',
    '.palette-copy-feedback code': '.palette-copy-feedback',
    '.palette-swatch-label': '.param-group',
    '.tab-btn': '.tab-btn',
    '.tab-btn.active': '.tab-btn.active',
  },
  'shader.css': {
    '.shader-toolbar': ['.shader-toolbar', '.layout-container'],
    '.shader-toolbar label': ['.shader-toolbar', '.layout-container'],
    '.shader-toolbar select': '.shader-toolbar select',
    '.shader-toolbar button': ['.shader-toolbar', '.layout-container'],
    '.shader-toolbar button:hover:not(:disabled), .shader-toolbar button:focus-visible':
      ['.shader-toolbar', '.layout-container'],
    '.shader-parity-toggle[aria-pressed="true"]:not(:disabled)':
      ['.shader-toolbar', '.layout-container'],
    '.shader-document-status': ['.shader-toolbar', '.layout-container'],
    '.shader-document-status[data-status="error"]': ['.shader-toolbar', '.layout-container'],
    '.chain-scroll-button': '.chain-scroll-button',
    '.chain-scroll-button:hover, .chain-scroll-button:focus-visible': '.chain-scroll-button',
    '.chain-chip': '.chain-chip',
    '.chain-chip:hover, .chain-chip:focus-visible': '.chain-chip',
    '.chain-chip[aria-current="true"]': '.chain-chip[aria-current="true"]',
    '.chain-chip-remove, .chain-chip-bypass, .chain-chip-move': '.chain-chip',
    ['.chain-chip-remove:hover, .chain-chip-remove:focus-visible,'
      + ' .chain-chip-bypass:hover:not(:disabled), .chain-chip-bypass:focus-visible,'
      + ' .chain-chip-move:hover:not(:disabled), .chain-chip-move:focus-visible']: '.chain-chip',
    '.chain-chip-bypass[aria-pressed="true"]': '.chain-chip',
    '.chain-chip-function-label': '.chain-chip',
    '.chain-chip-replace': '.chain-chip-replace',
    '.chain-param-name': '.chain-chip',
    '.chain-param-note': '.chain-chip',
    '.chain-param-control': '.chain-chip',
    '.chain-param-option': '.chain-param-option',
    '.chain-param-value': '.chain-param-value',
    '.chain-palette-entry:hover, .chain-palette-entry:focus-visible':
      '.chain-palette-entry:hover, .chain-palette-entry:focus-visible',
    '.chain-palette-entry--remove': '.chain-palette-entry',
  },
  'solids.css': {
    '.thumb-btn .thumb-label': '.thumb-btn',
    '.thumb-name-full': ['.thumb-name-full', '.thumb-btn'],
    '.move-op-btn': '.op-item',
    '.saved-item .title': '.saved-item',
    '.saved-item .details': '.saved-item',
    '.action-btn': '.action-btn',
    '.action-btn:hover': '.action-btn:hover',
  },
};

// Sheet -> text rule -> why no pair measures it. An empty reason is no
// exemption: the sweep falls back to demanding a surface for it.
const CONTRAST_EXEMPT = {
  'mobius.css': {
    '.preset-btn.active': 'pressed fill is 20% blue over the translucent sidebar, which the '
      + 'live canvas backs',
  },
  'shader.css': {
    '.shader-toolbar button:disabled':
      'inactive control, which SC 1.4.3 exempts from the contrast floor',
    '.chain-strip-region': 'the strip floats over the live canvas; no rule paints behind it',
    '.chain-strip-actions button': 'floats over the live canvas on a transparent fill',
    '.chain-strip-actions button:disabled':
      'inactive control, which SC 1.4.3 exempts from the contrast floor',
    '.chain-strip-note': 'floats over the live canvas; the strip paints no fill behind it',
    '.chain-band-title': 'band tint is 10% carrier over the live canvas',
    '.chain-band-add': 'band tint is 10% carrier over the live canvas',
    '.chain-chip-move:disabled, .chain-chip-bypass:disabled':
      'inactive controls, which SC 1.4.3 exempts from the contrast floor',
    '.chain-chip-bypass:disabled[aria-pressed="true"]':
      'inactive control, which SC 1.4.3 exempts from the contrast floor',
    ['#gui-container .lil-controller.lil-option select,'
      + ' #gui-container .lil-controller.lil-option option']:
      'lil-gui sets --text-color and --background-color in its own vendored stylesheet',
  },
  'solids.css': {
    '.drag-handle': 'an SVG grip, not text; SC 1.4.3 is a text criterion',
    '#meshStats': 'translucent readout over the live canvas',
  },
};

/**
 * Every rule in a stylesheet, comments dropped and selector whitespace
 * collapsed to the single spaces the tables above spell them with.
 * @param {string} css - Stylesheet text.
 * @returns {string[][]} `[selector, declarations]` per rule, in source order.
 */
const rules = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')
  .filter((chunk) => chunk.includes('{'))
  .map((chunk) => [chunk.slice(0, chunk.indexOf('{')).replace(/\s+/g, ' ').trim(),
    chunk.slice(chunk.indexOf('{') + 1)]);

/** Whether a declaration block sets `color` itself, not `background-color`. */
const declaresColor = (declarations) => /(?:^|;)\s*color\s*:/.test(declarations);

/**
 * One rule's declaration block, every same-selector rule in the cascade joined
 * so a later sheet's override reads the way the browser resolves it.
 * @param {string} css - Stylesheet text.
 * @param {string} selector - The rule's selector, exactly as written.
 * @returns {string} Everything between its braces.
 */
function ruleBody(css, selector) {
  const bodies = rules(css).filter(([name]) => name === selector).map(([, body]) => body);
  if (bodies.length === 0) return assert.fail(`the cascade declares no ${selector} rule`);
  return bodies.join(';');
}

/**
 * A property's value, with every `var()` reference resolved against :root.
 * @param {string} css - Stylesheet text.
 * @param {string} selector - Rule to read.
 * @param {string} property - Property to read.
 * @returns {string} The value, as a colour literal.
 */
function color(css, selector, property) {
  const declarations = [...ruleBody(css, selector)
    .matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))];
  const declared = declarations.at(-1);
  assert.ok(declared, `${selector} declares no ${property}`);
  let value = declared[1].trim();
  for (let depth = 0; value.includes('var('); depth += 1) {
    assert.ok(depth < 8,
      `${selector} ${property} resolves to ${value}, a var() this reader loops on`);
    value = value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, token) => color(css, ':root', token));
  }
  return value;
}

/**
 * A rule's fill, whichever of the two properties declares it.
 * @param {string} css - Stylesheet text.
 * @param {string} selector - Rule to read.
 * @returns {string} The value, as a colour literal.
 */
const fill = (css, selector) => color(css, selector,
  /(?:^|;)\s*background-color\s*:/.test(ruleBody(css, selector))
    ? 'background-color' : 'background');

/**
 * A colour literal's channels.
 * @param {string} value - A `#rgb`, `#rrggbb`, `white`, `rgb()` or `rgba()` literal.
 * @returns {number[]} `[red, green, blue]` over 255, then alpha over 1.
 */
function channels(value) {
  const literal = value.trim() === 'white' ? '#ffffff' : value.trim();
  const hex = literal.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const pairs = hex.length === 3 ? [...hex].map((c) => c + c) : hex.match(/../g);
    return [...pairs.map((pair) => parseInt(pair, 16)), 1];
  }
  const inside = literal.match(/^rgba?\(([^)]*)\)$/)?.[1];
  const parts = inside?.replace('/', ' ').trim().split(/[\s,]+/).map(Number);
  if (parts && (parts.length === 3 || parts.length === 4) && parts.every((n) => !Number.isNaN(n))) {
    return [...parts.slice(0, 3), parts.length === 4 ? parts[3] : 1];
  }
  return assert.fail(`${value} is a colour this reader cannot measure`);
}

/**
 * WCAG relative luminance of a colour.
 * @param {number[]} rgb - Channels over 255.
 * @returns {number} Its luminance in [0, 1].
 */
function luminance(rgb) {
  const linear = rgb.slice(0, 3).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * The colour a stack of fills composites to, front to back.
 * @param {string} css - Stylesheet text.
 * @param {string|string[]} selectors - Rules declaring the fills.
 * @returns {number[]} Channels of the opaque result.
 */
function surface(css, selectors) {
  const stack = [].concat(selectors).map((selector) => channels(fill(css, selector)));
  assert.equal(stack.at(-1)[3], 1,
    `${[].concat(selectors).at(-1)} is the backmost fill of a pair and has to be opaque`);
  return stack.reduceRight((back, front) => [
    ...front.slice(0, 3).map((c, at) => c * front[3] + back[at] * (1 - front[3])), 1]);
}

/**
 * Contrast ratio between one rule's text colour and the surface under it.
 * @param {string} css - Stylesheet text.
 * @param {string} text - Rule declaring `color`.
 * @param {string|string[]} surfaces - Rules declaring the fills under it.
 * @returns {number} The WCAG contrast ratio.
 */
function contrast(css, text, surfaces) {
  const ink = channels(color(css, text, 'color'));
  assert.equal(ink[3], 1, `${text} is translucent; measure it against what it composites over`);
  const [light, dark] = [ink, surface(css, surfaces)].map(luminance).sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('CSS readers ignore comments and honor later declarations', () => {
  const css = '/* .comment-only {} */ .real { color: #111111; } .real { color: #222222; }';
  assert.deepEqual([...definedClasses(css)], ['real']);
  assert.equal(color(css, '.real', 'color'), '#222222');
  assert.deepEqual(channels('rgb(20 20 20 / 0.95)'), [20, 20, 20, 0.95]);
  assert.deepEqual(channels('#48f'), [68, 136, 255, 1]);
});

/**
 * Sweeps every colour the tools/ stylesheets declare against the WCAG AA floor,
 * each in the cascade its page builds, so a token retuned for looks fails here
 * wherever the pages that load it sit text on too near a fill.
 */
test('every colour a tools/ stylesheet declares clears the WCAG AA floor or says why not', () => {
  for (const { page, sheets } of SERVED_PAGES) {
    const cascade = sheets.map((sheet) => read(...sheet)).join('\n');
    const swept = sheets.filter(([dir, name]) => dir === 'tools' && name !== 'tailwind.css');
    for (const sheet of swept) {
      const name = sheet.at(-1);
      const surfaces = CONTRAST_SURFACES[name] ?? {};
      const exempt = CONTRAST_EXEMPT[name] ?? {};
      const selectors = rules(read(...sheet)).filter(([, body]) => declaresColor(body))
        .map(([selector]) => selector);
      for (const selector of selectors) {
        if (exempt[selector]) continue;
        assert.ok(surfaces[selector],
          `${page}: ${name} colours ${selector} against no listed surface and no exemption`);
        const ratio = contrast(cascade, selector, surfaces[selector]);
        assert.ok(ratio >= AA_CONTRAST, `${name} ${selector} on ${surfaces[selector]} measures `
          + `${ratio.toFixed(2)}:1, under the ${AA_CONTRAST}:1 AA floor`);
      }
      const listed = [...Object.keys(surfaces), ...Object.keys(exempt)];
      assert.deepEqual(listed.filter((selector) => !selectors.includes(selector)), [],
        `${name} lists rules that declare no color`);
    }
  }
});
