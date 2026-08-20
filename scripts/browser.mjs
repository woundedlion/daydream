/*
 * The browser the headless scripts drive, and the flags they launch it under.
 * Nothing is downloaded: the browser is $CHROME_PATH, else one of the standard
 * Chrome/Chromium locations, and a machine with none fails rather than letting a
 * script report a green run over zero pages.
 */
import { existsSync } from 'node:fs';

export const BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
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
 * @returns {string} An existing executable path.
 * @throws {Error} When neither $CHROME_PATH nor any standard location exists.
 */
export function resolveBrowser(env = process.env) {
  const declared = env.CHROME_PATH;
  if (declared) {
    if (!existsSync(declared)) {
      throw new Error(`CHROME_PATH=${declared} does not exist.`);
    }
    return declared;
  }
  const found = BROWSER_CANDIDATES.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      'no Chrome or Chromium found. Set CHROME_PATH, or install one at ' +
        `${BROWSER_CANDIDATES.join(', ')}.`,
    );
  }
  return found;
}
