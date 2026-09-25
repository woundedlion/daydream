import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_PATHS = new Set(['README.md', 'holosphere_wasm.js', 'holosphere_wasm.wasm',
  'holosphere_wasm.sha', 'holosphere_wasm.wasm.sha256', 'holosphere_wasm.toolchain',
  'pov_segment_map.json', 'shader/shader_workbench.mjs', 'shader/sha256.mjs',
  'shader/engine_catalog.json']);

const ownedPath = (path) => REQUIRED_PATHS.has(path)
  || /^shader\/patterns\/[^/]+\.shader\.json$/.test(path)
  || path === 'shader/patterns/shaderball_migration.json'
  || /^docs\/screenshots\/.+\.png$/.test(path);

export function installEngineBundle(bundle, destination) {
  bundle = resolve(bundle);
  destination = resolve(destination);
  if (!existsSync(resolve(destination, 'daydream.js')))
    throw new Error('Destination is not a Daydream checkout');
  const manifest = readFileSync(resolve(bundle, 'holosphere_engine.sha256'), 'utf8');
  const entries = manifest.trim().split(/\r?\n/).map((line) => {
    const match = /^([a-f0-9]{64})\s+\*?(?:\.\/)?(.+)$/.exec(line);
    if (!match) throw new Error('Invalid engine bundle checksum entry');
    const [, hash, path] = match;
    if (path.includes('\\') || path.split('/').some((part) => part === '..' || part === '')
        || !resolve(destination, path).startsWith(destination + sep))
      throw new Error(`Invalid engine bundle path: ${path}`);
    if (!ownedPath(path)) throw new Error(`Engine bundle carries unexpected path: ${path}`);
    const bytes = readFileSync(resolve(bundle, path));
    if (createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new Error(`Engine bundle checksum mismatch: ${path}`);
    return path;
  });
  const paths = new Set(entries);
  for (const required of REQUIRED_PATHS) {
    if (!paths.has(required)) throw new Error(`Engine bundle is missing ${required}`);
  }
  const installedPin = readFileSync(resolve(destination, 'holosphere_wasm.sha'), 'utf8').trim();
  const bundlePin = readFileSync(resolve(bundle, 'holosphere_wasm.sha'), 'utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(bundlePin)) throw new Error('Invalid engine bundle source pin');
  if (process.env.HOLOSPHERE_BUNDLE_PIN && bundlePin !== process.env.HOLOSPHERE_BUNDLE_PIN)
    throw new Error(`Engine bundle source pin differs from ${process.env.HOLOSPHERE_BUNDLE_PIN}`);
  const stale = [];
  for (const directory of ['shader/patterns', 'docs/screenshots']) {
    const root = resolve(destination, directory);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      const relative = resolve(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/');
      if (entry.isFile() && ownedPath(`${directory}/${relative}`)
          && !paths.has(`${directory}/${relative}`))
        stale.push(`${directory}/${relative}`);
    }
  }
  const scratch = mkdtempSync(resolve(destination, '.hs-tmp-'));
  const backedUp = [];
  const installed = [];
  let recoverable = true;
  try {
    for (const path of entries) {
      const staged = resolve(scratch, 'staged', path);
      mkdirSync(dirname(staged), { recursive: true });
      copyFileSync(resolve(bundle, path), staged);
    }
    for (const path of [...entries, ...stale]) {
      const current = resolve(destination, path);
      if (!existsSync(current)) continue;
      const backup = resolve(scratch, 'backup', path);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(current, backup);
      backedUp.push(path);
    }
    for (const path of entries) {
      mkdirSync(dirname(resolve(destination, path)), { recursive: true });
      renameSync(resolve(scratch, 'staged', path), resolve(destination, path));
      installed.push(path);
    }
  } catch (error) {
    try {
      for (const path of installed.reverse()) rmSync(resolve(destination, path));
      for (const path of backedUp.reverse())
        renameSync(resolve(scratch, 'backup', path), resolve(destination, path));
    } catch (rollbackError) {
      recoverable = false;
      throw new AggregateError([error, rollbackError],
        `Engine install rollback failed; recovery files remain in ${scratch}`, { cause: rollbackError });
    }
    throw error;
  } finally {
    if (recoverable) rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`Installed ${entries.length} engine assets (${installedPin} -> ${bundlePin})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [bundle, destination = '.'] = process.argv.slice(2);
  if (!bundle) throw new Error('Usage: install-engine-bundle.mjs <bundle> [daydream]');
  installEngineBundle(bundle, destination);
}
