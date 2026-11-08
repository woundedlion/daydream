// Tests for scripts/browser.mjs, which picks the browser the headless-Chrome
// probes drive and fails loudly when none is installed, and for the probe
// harness's problem collector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { BROWSER_ARGS, BROWSER_CANDIDATES, resolveBrowser } from '../scripts/browser.mjs';
import { collectProblems } from '../scripts/probe_harness.mjs';

/** @param {string} origin @returns {{listeners: Map<string, Function>, problems: string[]}} Probe capture. */
function probeTab(origin) {
  const listeners = new Map();
  const problems = [];
  collectProblems({ on: (name, handler) => listeners.set(name, handler) }, origin, problems);
  return { listeners, problems };
}

test('a declared CHROME_PATH is the browser, when it exists', () => {
  assert.equal(resolveBrowser({ CHROME_PATH: process.execPath }), process.execPath);
});

test('a declared CHROME_PATH that does not exist is a refusal, not a fallback', () => {
  assert.throws(
    () => resolveBrowser({ CHROME_PATH: '/no/such/browser' }),
    /CHROME_PATH=\/no\/such\/browser does not exist/,
    'falling back would drive a browser the caller did not ask for');
});

// Driven over their own candidate lists, independent of the machine's Chrome.
test('with no CHROME_PATH and no candidate installed, nothing is answered', () => {
  assert.throws(
    () => resolveBrowser({}, ['/no/such/chrome', '/no/such/edge']),
    /no Chrome, Chromium or Edge found[\s\S]*\/no\/such\/chrome, \/no\/such\/edge/,
    'answering nothing would report a green run over zero pages and zero gestures');
});

test('with no CHROME_PATH the first installed candidate answers', () => {
  assert.equal(
    resolveBrowser({}, ['/no/such/chrome', process.execPath, '/no/such/edge']),
    process.execPath,
    'a missing earlier candidate is skipped rather than preferred');
});

// Same result either way on any machine: installed or not, the default search
// list is the exported one.
test('an undeclared resolve searches the standard locations', () => {
  const attempt = (...args) => {
    try {
      return resolveBrowser(...args);
    } catch (error) {
      return error.message;
    }
  };
  assert.equal(attempt({}), attempt({}, BROWSER_CANDIDATES));
  assert.ok(BROWSER_CANDIDATES.includes('/usr/bin/google-chrome'),
    'the headless jobs run on Linux');
  for (const path of BROWSER_CANDIDATES) assert.match(path, /chrome|chromium|edge/i);
});

test('the launch flags carry the runner a GPU-less rasterizer', () => {
  assert.ok(BROWSER_ARGS.includes('--no-sandbox'));
  assert.ok(BROWSER_ARGS.includes('--use-angle=swiftshader'),
    'a runner has no GPU, and every workbench page renders through WebGL');
  assert.ok(BROWSER_ARGS.includes('--enable-unsafe-swiftshader'));
});

test('the launch flags put external asset CDNs beyond every probe', () => {
  assert.ok(BROWSER_ARGS.includes('--host-resolver-rules=MAP cdn.jsdelivr.net ~NOTFOUND'),
    'the probes are served three.js and lil-gui from their own origin; a page '
      + 'that reached jsdelivr instead would hand a CDN incident the power to '
      + 'red the required gate');
});

for (const localAppData of [undefined, 'C:/Users/browser-fixture/AppData/Local']) {
  test(`CDN smoke respects ${localAppData ? 'a declared' : 'an absent'} per-user browser directory`, () => {
    const env = { ...process.env, HS_CDN_SMOKE: '1' };
    if (localAppData) env.LOCALAPPDATA = localAppData;
    else delete env.LOCALAPPDATA;
    const source = new URL('../scripts/browser.mjs', import.meta.url).href;
    const browser = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { BROWSER_ARGS, BROWSER_CANDIDATES } from ${JSON.stringify(source)};
       console.log(JSON.stringify({ BROWSER_ARGS, BROWSER_CANDIDATES }));`,
    ], { env, encoding: 'utf8' }));
    assert.equal(browser.BROWSER_ARGS.some(flag => flag.startsWith('--host-resolver-rules=')), false);
    assert.ok(browser.BROWSER_ARGS.includes('--use-angle=swiftshader'));
    assert.deepEqual(browser.BROWSER_CANDIDATES.filter(path => path.includes('/AppData/')),
      localAppData ? [`${localAppData}/Google/Chrome/Application/chrome.exe`] : []);
    assert.ok(browser.BROWSER_CANDIDATES.includes('/usr/bin/google-chrome'));
  });
}

/**
 * Asserts one problem per expected entry, each naming every fragment it lists.
 * @param {string[]} problems - The probe's reported problems.
 * @param {string[][]} expected - Fragments each problem must contain, in order.
 */
function assertProblems(problems, expected) {
  assert.equal(problems.length, expected.length, problems.join('\n'));
  expected.forEach((fragments, i) => {
    for (const fragment of fragments) assert.ok(problems[i].includes(fragment), `${problems[i]} lacks ${fragment}`);
  });
}

test('font and script request failures are problems', () => {
  const { listeners, problems } = probeTab('http://127.0.0.1:8000');
  const failed = listeners.get('requestfailed');
  failed({
    url: () => 'http://127.0.0.1:8000/styles/fonts/inter-latin.woff2',
    failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
  });
  failed({
    url: () => 'https://example.test/app.js',
    failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
  });
  assertProblems(problems, [
    ['http://127.0.0.1:8000/styles/fonts/inter-latin.woff2', 'net::ERR_NAME_NOT_RESOLVED'],
    ['https://example.test/app.js', 'net::ERR_NAME_NOT_RESOLVED'],
  ]);
});

test('console errors, uncaught exceptions and error responses are problems', () => {
  const origin = 'http://127.0.0.1:8000';
  const { listeners, problems } = probeTab(origin);
  assert.deepEqual([...listeners.keys()].sort(),
    ['console', 'pageerror', 'request', 'requestfailed', 'requestfinished', 'response']);

  const message = (type, text, url) =>
    ({ type: () => type, text: () => text, location: () => url && { url } });
  const logged = listeners.get('console');
  logged(message('warning', 'slow frame', `${origin}/daydream.js`));
  logged(message('error', 'Failed to load resource', `${origin}/favicon.ico`));
  logged(message('error', 'Failed to load resource', `${origin}/vendor/fonts/fonts.css`));
  logged(message('error', 'Failed to load resource', `${origin}/styles/fonts/inter-latin.woff2`));
  logged(message('error', 'chip render threw', `${origin}/tools/chain_strip.js`));
  logged(message('error', 'TypeError: x is undefined', undefined));

  listeners.get('pageerror')(new Error('boom'));

  const response = (status, url) => ({ status: () => status, url: () => url });
  const responded = listeners.get('response');
  responded(response(200, `${origin}/daydream.js`));
  responded(response(404, `${origin}/favicon.ico`));
  responded(response(404, `${origin}/vendor/fonts/fonts.css`));
  responded(response(404, `${origin}/styles/fonts.css`));
  responded(response(404, 'https://example.test/favicon.ico'));
  responded(response(500, `${origin}/tools/shader.html`));

  assertProblems(problems, [
    ['Failed to load resource'],
    ['Failed to load resource'],
    ['chip render threw'],
    ['TypeError: x is undefined'],
    ['boom'],
    ['404', `${origin}/vendor/fonts/fonts.css`],
    ['404', `${origin}/styles/fonts.css`],
    ['404', 'https://example.test/favicon.ico'],
    ['500', `${origin}/tools/shader.html`],
  ]);
});

for (const prefix of ['/daydream', '/nested/daydream/']) {
  test(`expected missing assets are scoped to the app base ${prefix}`, () => {
    const origin = 'http://127.0.0.1:8000';
    const base = new URL(`${origin}${prefix.replace(/\/$/, '')}/`);
    const { listeners, problems } = probeTab(`${origin}${prefix}`);

    const report = (url) => {
      listeners.get('requestfailed')({
        url: () => url,
        failure: () => ({ errorText: 'net::ERR_ABORTED' }),
      });
      listeners.get('console')({
        type: () => 'error',
        text: () => `Failed to load ${url}`,
        location: () => ({ url }),
      });
      listeners.get('response')({ status: () => 404, url: () => url });
    };

    report(new URL('favicon.ico', base).href);
    report('favicon.ico');
    report(`${origin}/favicon.ico`);
    assert.deepEqual(problems, []);

    const unexpected = [
      new URL('vendor/fonts/fonts.css', base).href,
      'vendor/fonts/fonts.css',
      `${origin}/vendor/fonts/fonts.css`,
      `${origin}/other/vendor/fonts/fonts.css`,
      new URL('other/fonts.css', base).href,
      'https://example.test/daydream/vendor/fonts/fonts.css',
    ];
    for (const url of unexpected) report(url);
    listeners.get('pageerror')(new Error('font loading threw'));
    assertProblems(problems, [
      ...unexpected.flatMap((url) => [[url, 'net::ERR_ABORTED'], [`Failed to load ${url}`], ['404', url]]),
      ['font loading threw'],
    ]);
  });
}
