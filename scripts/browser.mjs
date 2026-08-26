/*
 * The browser the headless scripts drive, and the flags they launch it under.
 * Nothing is downloaded: the browser is $CHROME_PATH, else one of the standard
 * Chrome/Chromium/Edge locations, and a machine with none fails rather than
 * letting a script report a green run over zero pages.
 */
import { existsSync } from 'node:fs';

// Linux first: it is what the headless jobs run on, and no runner carries the
// other platforms' paths. Windows paths are spelled with forward slashes, which
// node resolves there. $LOCALAPPDATA is Chrome's per-user Windows install, which
// sits outside Program Files.
export const BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ...(process.env.LOCALAPPDATA
    ? [`${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`]
    : []),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

// Software rasterization because a runner has no GPU and every workbench page
// renders through WebGL.
export const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

/**
 * Path of the browser to drive.
 * @param {Object<string, string|undefined>} [env] - Environment to read
 *   CHROME_PATH from; the process environment by default.
 * @param {string[]} [candidates] - Locations to search when no CHROME_PATH is
 *   declared; the standard install paths by default.
 * @returns {string} An existing executable path.
 * @throws {Error} When neither $CHROME_PATH nor any candidate exists.
 */
export function resolveBrowser(env = process.env, candidates = BROWSER_CANDIDATES) {
  const declared = env.CHROME_PATH;
  if (declared) {
    if (!existsSync(declared)) {
      throw new Error(`CHROME_PATH=${declared} does not exist.`);
    }
    return declared;
  }
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      'no Chrome, Chromium or Edge found. Set CHROME_PATH, or install one at ' +
        `${candidates.join(', ')}.`,
    );
  }
  return found;
}
