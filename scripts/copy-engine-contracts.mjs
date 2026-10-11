import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE_CONTRACT_PATHS } from './install-engine-bundle.mjs';

/**
 * Copy missing installed contracts into a source checkout before typechecking.
 * @param {string} source Installed checkout.
 * @param {string} destination Source checkout being checked.
 * @returns {void}
 */
export function copyEngineContracts(source, destination) {
  const missing = [...ENGINE_CONTRACT_PATHS].filter((path) =>
    !existsSync(resolve(destination, path)));
  for (const path of missing) {
    if (!existsSync(resolve(source, path)))
      throw new Error(`Install the engine bundle before pushing: missing ${path}`);
  }
  for (const path of missing) {
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(source, path), target);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error('Usage: copy-engine-contracts.mjs <installed-checkout> <source-checkout>');
  copyEngineContracts(source, destination);
}
