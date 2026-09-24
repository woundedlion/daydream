import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';

export async function checkCdnIntegrity(source, fetchModule = fetch, wait = delay) {
  let map;
  runInNewContext(source, {
    URL,
    window: {},
    document: {
      currentScript: { src: 'https://example.org/vendor-importmap.js' },
      createElement: () => ({}),
      head: { appendChild: (script) => { map = JSON.parse(script.textContent); } },
    },
  }, { timeout: 1000 });
  const entries = Object.entries(map?.integrity ?? {});
  if (entries.length === 0) throw new Error('CDN integrity map is empty');
  for (const [url, expected] of entries) {
    if (!url.startsWith('https://cdn.jsdelivr.net/npm/'))
      throw new Error(`Unexpected CDN URL: ${url}`);
    let bytes;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchModule(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await wait(250 * 2 ** attempt);
      }
    }
    const actual = `sha384-${createHash('sha384')
      .update(bytes).digest('base64')}`;
    if (actual !== expected) throw new Error(`${url}: integrity mismatch`);
  }
  return entries.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const source = readFileSync(new URL('../vendor-importmap.js', import.meta.url), 'utf8');
  console.log(`CDN integrity: ${await checkCdnIntegrity(source)} modules verified`);
}
