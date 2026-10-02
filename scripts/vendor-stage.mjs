/*
 * Stages the publication manifest into a scratch site with three.js and lil-gui
 * from node_modules for the headless probes.
 * Manifest files are hard-linked; generate the local import map into a separate
 * inode so writing it cannot change the committed map.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync,
  rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestEntries } from './site-pages.mjs';
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
export function stageProbeSite() {
  const root = mkdtempSync(join(tmpdir(), 'daydream-staged-site-'));
  let entries;
  try {
    entries = manifestEntries();
    for (const entry of entries) {
      if (entry === IMPORTMAP) continue;
      const from = join(REPO, entry);
      if (!existsSync(from)) throw new Error(`site manifest entry is missing: ${entry}`);
      linkInto(from, join(root, entry));
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
  const vendorFiles = VENDOR_ENTRIES.flatMap((directory) =>
    readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/')));
  return { root, entries: [...entries, ...vendorFiles] };
}

/**
 * Serves the staged site, the way serveManifest serves the repository.
 * @returns {Promise<{root: string, origin: string, close: () => Promise<void>}>} The listening
 *   origin and a shutdown that also removes the staged tree.
 */
export async function serveStagedSite() {
  const staged = stageProbeSite();
  let site;
  try {
    site = await serveManifest(staged.entries, staged.root);
  } catch (error) {
    rmSync(staged.root, { recursive: true, force: true });
    throw error;
  }
  return {
    root: staged.root,
    origin: site.origin,
    close: async () => {
      await site.close();
      rmSync(staged.root, { recursive: true, force: true });
    },
  };
}
