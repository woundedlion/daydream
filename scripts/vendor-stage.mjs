/*
 * Stages the published site into a scratch tree whose three.js and lil-gui come
 * out of node_modules, and serves that tree to the headless probes.
 *
 * The committed import map resolves both libraries from cdn.jsdelivr.net, which
 * is what the Pages deploy serves and what a fresh checkout gets. Loading them
 * over the network on every probe navigation would put the required browser
 * gate — and the deploy behind it — at the mercy of a CDN incident, so the gate
 * runs against a locally generated `local` map instead. `npm ci` has already
 * fetched the pinned versions; nothing here changes what the deploy serves.
 *
 * The manifest set is hard-linked rather than copied: only the import map is
 * written into the staged tree, and it is generated there rather than linked so
 * the shared inode cannot rewrite the committed file.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync,
  rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestEntries } from '../tests/site_pages.js';
import { serveManifest } from './serve-manifest.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = join(REPO, 'scripts', 'generate-importmap.mjs');

// Generated into the staged tree, never linked into it.
const IMPORTMAP = 'vendor-importmap.js';

// Installed package paths, and where vendor-importmap.js's `local` mode looks
// for each of them: `three.js/` for three, node_modules for lil-gui.
const VENDORED = [
  ['node_modules/three/build', 'three.js/build'],
  ['node_modules/three/examples/jsm', 'three.js/examples/jsm'],
  [
    'node_modules/lil-gui/dist/lil-gui.esm.min.js',
    'node_modules/lil-gui/dist/lil-gui.esm.min.js',
  ],
];

// The server publishes site_manifest.txt's set only, so the vendored trees need
// entries of their own or every library request 404s.
const VENDOR_ENTRIES = ['three.js', 'node_modules'];

/**
 * Hard-links a file or a whole directory into the staged tree, falling back to a
 * copy on a filesystem that refuses the link.
 * @param {string} from - Absolute source path.
 * @param {string} to - Absolute destination path.
 * @returns {void}
 */
function linkInto(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      linkInto(join(from, entry), join(to, entry));
    }
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * Builds the scratch site: the manifest set, the vendored libraries, and an
 * import map that resolves both from them.
 * @returns {{root: string, entries: string[]}} The staged root and the set to serve.
 * @throws {Error} When the pinned libraries are not installed.
 */
export function stageSite() {
  const root = mkdtempSync(join(tmpdir(), 'daydream-staged-site-'));
  try {
    for (const entry of manifestEntries()) {
      if (entry === IMPORTMAP) continue;
      const from = join(REPO, entry);
      if (existsSync(from)) linkInto(from, join(root, entry));
    }
    for (const [from, to] of VENDORED) {
      const source = join(REPO, from);
      if (!existsSync(source)) {
        throw new Error(
          `vendor-stage: ${from} is missing — run \`npm ci\` before the browser probes.`);
      }
      linkInto(source, join(root, to));
    }
    execFileSync(
      process.execPath,
      [GENERATOR, '--local', '--vendor-root', root, '--out', join(root, IMPORTMAP)],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, entries: [...manifestEntries(), ...VENDOR_ENTRIES] };
}

/**
 * Serves the staged site, the way serveManifest serves the repository.
 * @returns {Promise<{origin: string, close: () => Promise<void>}>} The listening
 *   origin and a shutdown that also removes the staged tree.
 */
export async function serveStagedSite() {
  const staged = stageSite();
  let site;
  try {
    site = await serveManifest(staged.entries, staged.root);
  } catch (error) {
    rmSync(staged.root, { recursive: true, force: true });
    throw error;
  }
  return {
    origin: site.origin,
    close: async () => {
      await site.close();
      rmSync(staged.root, { recursive: true, force: true });
    },
  };
}
