// Counts the node:assert calls a test file runs. scripts/run-tests.mjs loads
// this through NODE_OPTIONS, so every process `node --test` spawns wraps its
// own copy of node:assert and drops its count in $DAYDREAM_ASSERTION_COUNTS for
// the runner to aggregate. NODE_TEST_CONTEXT gates it, so a process that only
// inherits the environment — the runner, a script a test spawns — writes none.
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.DAYDREAM_ASSERTION_COUNTS;
const file = process.argv[1];
if (dir && file && process.env.NODE_TEST_CONTEXT) {
  let count = 0;
  // `node:assert/strict`'s default export is assert.strict, so wrapping both
  // objects covers either specifier. Capitalized keys are the AssertionError
  // and CallTracker classes and `strict` is the other object; every remaining
  // function property is an assertion. Each wrapper calls the function it
  // captured, not the property, so an alias held by two properties
  // (strict.equal is assert.strictEqual) still scores one per call.
  for (const target of [assert, assert.strict]) {
    for (const key of Object.keys(target)) {
      const fn = target[key];
      if (typeof fn !== 'function' || key === 'strict' || !/^[a-z]/.test(key))
        continue;
      target[key] = (...args) => {
        count += 1;
        return fn.apply(target, args);
      };
    }
  }
  // A random name rather than the pid: pids are recycled within one run, and a
  // reused name would drop the earlier file's count.
  process.on('exit', () => {
    writeFileSync(
      join(dir, `${randomUUID()}.json`),
      JSON.stringify({ file, count }),
    );
  });
}
