// The served set, read from site_manifest.txt. The CSP, stylesheet and
// module-reachability cases all run over this roster, so a page added to the
// manifest is gated by them without a second list to keep in step.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * site_manifest.txt's entries.
 * @returns {string[]} Repo-relative paths, comments and blank lines dropped.
 */
export function manifestEntries() {
  return readFileSync(resolve(REPO, 'site_manifest.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * The pages a visitor can load directly; everything else is reached from one of
 * them.
 * @returns {string[]} Repo-relative page paths, sorted.
 */
export function servedPages() {
  return manifestEntries().filter((entry) => entry.endsWith('.html')).sort();
}
