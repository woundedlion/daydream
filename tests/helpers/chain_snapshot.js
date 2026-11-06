import { CHAIN_SNAPSHOT_SCHEMA_VERSION } from '../../src/workbench/shader/shader_deeplink.js';
import { getChainSnapshot } from '../../src/engine/workbench_bindings.js';
import { FakeChainEngine } from './fake_engine.js';

/** @param {Object} [overrides] @returns {Object} A fresh current-format default-chain snapshot. */
export function currentChainSnapshot(overrides = {}) {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  return {
    ...getChainSnapshot(engine),
    ...structuredClone(overrides),
    schemaVersion: CHAIN_SNAPSHOT_SCHEMA_VERSION,
  };
}
