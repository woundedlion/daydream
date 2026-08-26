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
    /** @type {?string} */
    let target = null;
    try {
      const requested = decodeURIComponent(
        new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
      const path = requested === '' ? 'index.html' : requested;
      const candidate = resolve(root, path);
      if (served(path) && candidate.startsWith(`${root}${sep}`) &&
        existsSync(candidate) && statSync(candidate).isFile()) {
        target = candidate;
      }
    } catch {
      // A malformed percent escape, or a file that moved between the two calls.
    }
    if (target === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not in site_manifest.txt\n');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    });
    const body = createReadStream(target);
    // The headers are already out, so a read fault can only be reported by
    // cutting the response short.
    body.on('error', () => res.destroy());
    body.pipe(res);
  });

  await new Promise((done, fail) => {
    /** @param {Error} error */
    const refuse = (error) => fail(error);
    server.once('error', refuse);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', refuse);
      // Past the bind nothing is left to settle, and an unhandled 'error' event
      // would take the process down under the probe still running.
      server.on('error',
        (error) => console.error(`serve-manifest: ${error.message}`));
      done(undefined);
    });
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
