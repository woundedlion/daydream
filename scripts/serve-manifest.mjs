/*
 * The static server the headless probes load their pages over: it publishes
 * exactly the entries it is handed out of one directory, so the smoke sees the
 * layout deploy.yml stages rather than the whole tree. scripts/vendor-stage.mjs
 * points it at a scratch copy that vendors three.js and lil-gui.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A .wasm served as anything else drops Emscripten to the ArrayBuffer path, and
// a module served as text/plain is refused outright.
export const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * Serves the manifest set out of a directory.
 * @param {string[]} entries - site_manifest.txt's entries; a directory entry serves recursively.
 * @param {string} [root] - Directory the entries are relative to; the repository by default.
 * @returns {Promise<{origin: string, close: () => Promise<void>}>} The listening origin and its shutdown.
 */
export async function serveManifest(entries, root = ROOT) {
  const served = (path) =>
    entries.some((entry) => path === entry || path.startsWith(`${entry}/`));

  const server = createServer((req, res) => {
    const requested = decodeURIComponent(
      new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
    const path = requested === '' ? 'index.html' : requested;
    const target = resolve(root, path);
    const ok = served(path) && target.startsWith(`${root}${sep}`) &&
      existsSync(target) && statSync(target).isFile();
    if (!ok) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not in site_manifest.txt\n');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    });
    createReadStream(target).pipe(res);
  });

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the manifest server did not bind a port');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => server.close(() => done(undefined))),
  };
}
