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
import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert';
import strictAssert from 'node:assert/strict';
import * as nodeTest from 'node:test';

const dir = process.env.DAYDREAM_MODULE_LOADS;
if (dir && process.env.NODE_TEST_CONTEXT) {
  const loaded = new Set();
  const assertions = new AsyncLocalStorage();
  const counted = (original) => new Proxy(original, {
    apply(target, receiver, args) {
      const counter = assertions.getStore();
      for (let owner = counter; owner; owner = owner.parent) owner.calls++;
      return Reflect.apply(target, receiver, args);
    },
    get(target, key) {
      const member = Reflect.get(target, key);
      return typeof member === 'function' && key !== 'AssertionError'
        ? counted(member) : member;
    },
  });
  const wrapTest = (original) => new Proxy(original, {
    apply(target, receiver, args) {
      const callbackIndex = args.findLastIndex((arg) => typeof arg === 'function');
      if (callbackIndex >= 0) {
        const callback = args[callbackIndex];
        const instrument = (parameters, run) => assertions.run({ calls: 0, parent: assertions.getStore() }, () => {
          const counter = assertions.getStore();
          const context = parameters[0];
          if (context && typeof context.test === 'function') {
            parameters[0] = new Proxy(context, {
              get(target, key) {
                if (key === 'test') return wrapTest(target.test.bind(target));
                if (key === 'assert') return new Proxy(target.assert, {
                  get: (object, property) => counted(object[property].bind(object)),
                });
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          }
          return run(counter, parameters);
        });
        const verify = (counter) => assert.ok(counter.calls > 0, 'Every test case must execute an assertion');
        args[callbackIndex] = callback.length > 1
          ? function (context, done) {
            return instrument([context], (counter, parameters) => callback(...parameters, (error) => {
              try {
                if (error) throw error;
                verify(counter);
              } catch (failure) {
                done(failure);
                return;
              }
              done();
            }));
          }
          : (...parameters) => instrument(parameters, async (counter, wrapped) => {
            await callback(...wrapped);
            verify(counter);
          });
      }
      return Reflect.apply(target, receiver, args);
    },
    get(target, key) {
      return ['skip', 'only', 'todo'].includes(String(key))
        ? wrapTest(target[key]) : Reflect.get(target, key);
    },
  });
  const modules = {
    'node:assert': counted(assert),
    'node:assert/strict': counted(strictAssert),
    'node:test': { ...nodeTest, default: wrapTest(nodeTest.test),
      test: wrapTest(nodeTest.test), it: wrapTest(nodeTest.it) },
  };
  globalThis[Symbol.for('daydream.testModules')] = modules;
  const moduleUrl = (name) => {
    const exports = Object.keys(modules[name]).filter((key) => key !== 'default');
    const code = `const m = globalThis[Symbol.for('daydream.testModules')][${JSON.stringify(name)}];`
      + (name === 'node:test' ? 'export default m.default;' : 'export default m;')
      + exports.map((key) => `export const ${key} = m[${JSON.stringify(key)}];`).join('');
    return `data:text/javascript,${encodeURIComponent(code)}`;
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.conditions.includes('require') && Object.hasOwn(modules, specifier))
        return { url: moduleUrl(specifier), shortCircuit: true };
      return nextResolve(specifier, context);
    },
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
