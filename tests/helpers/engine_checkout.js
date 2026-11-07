import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const candidates = process.env.HOLOSPHERE_ENGINE_DIR
  ? [resolve(repo, process.env.HOLOSPHERE_ENGINE_DIR)]
  : ['engine', '../Holosphere', '../pov'].map((path) => resolve(repo, path));
/** Engine checkout, or undefined when discovery finds none. An invalid explicit HOLOSPHERE_ENGINE_DIR throws. */
export const engineRoot = candidates.find(
  (path) => existsSync(resolve(path, 'scripts/shader_workbench.mjs')));
if (process.env.HOLOSPHERE_ENGINE_DIR && !engineRoot) {
  throw new Error(`HOLOSPHERE_ENGINE_DIR does not resolve a Holosphere checkout: ${candidates[0]}`);
}
export const engineMissing = `no Holosphere checkout found in ${candidates.join(', ')}`;
/** Skip reason, or false when source checks must run under HOLOSPHERE_ENGINE_REQUIRED=1. */
export const engineSkip = engineRoot || process.env.HOLOSPHERE_ENGINE_REQUIRED === '1' ? false : engineMissing;
