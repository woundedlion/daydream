import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePair } from './deployment-pair.mjs';
import { ownedPath, verifyEngineBundle } from './install-engine-bundle.mjs';

export function verifiedEnginePaths(root, bundle) {
  const { entries } = verifyEngineBundle(bundle, root);
  for (const path of entries) {
    const file = resolve(root, path);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()
        || !realpathSync(file).startsWith(realpathSync(root) + sep)
        || !readFileSync(file).equals(readFileSync(resolve(bundle, path))))
      throw new Error(`Installed engine asset differs from verified bundle: ${path}`);
  }
  return entries;
}

export function sitePaths(root, bundle) {
  const entries = readFileSync(resolve(root, 'site_manifest.txt'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!bundle) return entries;
  const verified = verifiedEnginePaths(root, bundle);
  const screenshots = new Set(readFileSync(resolve(root, 'README.md'), 'utf8')
    .match(/docs\/screenshots\/[\w.-]+\.png/g) ?? []);
  const published = verified.filter((path) => entries.includes(path) || screenshots.has(path)
    || (path.startsWith('generated/shader/patterns/') && path !== 'generated/shader/patterns/example.shader.json'));
  return [...new Set([...entries.filter((path) => !ownedPath(path)), ...published])];
}

export function stageSite(root, bundle, destination, pair) {
  validatePair(pair);
  if (!bundle) throw new Error('A verified engine bundle is required');
  root = resolve(root);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== pair.daydream || readFileSync(resolve(root, 'generated/holosphere_wasm.sha'), 'utf8').trim() !== pair.holosphere)
    throw new Error('Deployment pair differs from the selected sources');
  destination = resolve(destination);
  const committed = (path) => execFileSync('git', ['-C', root, 'show', `HEAD:${path}`]);
  if (!readFileSync(resolve(root, 'site_manifest.txt')).equals(committed('site_manifest.txt')))
    throw new Error('Site manifest differs from the selected daydream commit');
  const paths = sitePaths(root, bundle);
  for (const path of paths) {
    if (!path || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')
        || !resolve(root, path).startsWith(root + sep))
      throw new Error(`Invalid site path: ${path}`);
    const source = resolve(root, path);
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()
        || !realpathSync(source).startsWith(realpathSync(root) + sep))
      throw new Error(`Site entry is not a regular repository file: ${path}`);
    if (!ownedPath(path) && !readFileSync(source).equals(committed(path)))
      throw new Error(`Site source differs from the selected daydream commit: ${path}`);
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  writeFileSync(resolve(destination, 'deployment-pair.json'), JSON.stringify(pair, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [bundle, destination, pairFile] = process.argv.slice(2);
  if (!bundle || !destination || !pairFile) throw new Error('Usage: stage-site.mjs bundle destination pair.json');
  stageSite('.', bundle, destination, JSON.parse(readFileSync(pairFile, 'utf8')));
}
