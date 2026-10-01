import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callWorkbenchBinding, shaderChainCatalog } from '../src/engine/workbench_bindings.js';

test('typed capability takes precedence over a forwarding engine method and releases its handle', () => {
  const calls = [];
  const engine = {
    setShaderChain: () => { throw new Error('forwarding method reached'); },
    getShaderChainBindings: () => ({
      setShaderChain: (entries) => { calls.push(entries); return 'accepted'; },
      delete: () => { calls.push('released'); },
    }),
  };
  assert.equal(callWorkbenchBinding(engine, 'getShaderChainBindings', 'setShaderChain', [[]]), 'accepted');
  assert.deepEqual(calls, [[], 'released']);
});

test('unsupported capabilities never fall through to an engine forwarding method', () => {
  const engine = {
    getLegacyShaderBindings: () => null,
    getFullConfigSnapshot: () => { throw new Error('unsupported capability reached'); },
  };
  assert.equal(callWorkbenchBinding(engine, 'getLegacyShaderBindings', 'getFullConfigSnapshot', []), null);
  assert.equal(callWorkbenchBinding(null, 'getLegacyShaderBindings', 'getFullConfigSnapshot', []), null);
});

test('older installed modules retain their forwarding API during migration', () => {
  assert.equal(callWorkbenchBinding({ getFullConfigSnapshot: () => 'snapshot' },
    'getLegacyShaderBindings', 'getFullConfigSnapshot', []), 'snapshot');
});

test('ordinary errors release handles; module traps leave the halted module alone', () => {
  for (const error of [new Error('decode'), new WebAssembly.RuntimeError('trap')]) {
    let released = false;
    const engine = {
      getShaderChainBindings: () => ({
        setShaderChain: () => { throw error; },
        delete: () => { released = true; },
      }),
    };
    assert.throws(() => callWorkbenchBinding(engine, 'getShaderChainBindings', 'setShaderChain', [[]]),
      (caught) => caught === error);
    assert.equal(released, !(error instanceof WebAssembly.RuntimeError));
  }
});

test('catalog export uses the typed adapter and supports older module statics', () => {
  assert.equal(shaderChainCatalog({
    ShaderChainBindings: { getShaderChainCatalog: () => 'typed' },
    HolosphereEngine: { getShaderChainCatalog: () => 'forwarding' },
  }), 'typed');
  assert.equal(shaderChainCatalog({
    HolosphereEngine: { getShaderChainCatalog: () => 'forwarding' },
  }), 'forwarding');
});
