// Records the source modules a test process loads. scripts/run-tests.mjs loads
// this through NODE_OPTIONS, so every process `node --test` spawns — and every
// script a test spawns in turn — reports the files it imported into
// $DAYDREAM_MODULE_LOADS for the runner to gate the roster against.
//
// The record is what the module loader resolved, not what the test source says:
// a module named only in a comment, a string or a path never built is never
// loaded, so it never counts as covered. NODE_TEST_CONTEXT keeps the outer
// runner from writing, whose reporters and its own imports are not a test's.
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.DAYDREAM_MODULE_LOADS;
if (dir && process.env.NODE_TEST_CONTEXT) {
  const loaded = new Set();
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:')) loaded.add(url);
      return nextLoad(url, context);
    },
  });
  // A random name rather than the pid: pids are recycled within one run, and a
  // reused name would drop the earlier process's record.
  process.on('exit', () => {
    writeFileSync(join(dir, `${randomUUID()}.json`), JSON.stringify([...loaded]));
  });
}
