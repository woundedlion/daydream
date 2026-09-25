import { staticModuleGraph } from './module_graph.js';
const { ModuleWarmer: RealModuleWarmer, WARM_INTERVAL_MS, WARM_DEADLINE_MS, pageWarmer } =
  await import('../module_warmer.js');
const GRAPH = staticModuleGraph('segment_worker.js').modules;
const GLUE = new TextEncoder().encode('new URL("holosphere_wasm.wasm?v=abc123", import.meta.url)');
function withGlue(dependencies) {
  if (!dependencies?.fetch) return dependencies;
  const fetch = dependencies.fetch;
  return { ...dependencies, fetch: (url, options) => {
    const response = fetch(url, options);
    if (!url.pathname.endsWith('/holosphere_wasm.js')) return response;
    return response.then((value) => ({ ...value, arrayBuffer: async () => {
      await value.arrayBuffer();
      return GLUE.buffer;
    } }));
  } };
}
class ModuleWarmer extends RealModuleWarmer {
  warm(dependencies) { return super.warm(withGlue(dependencies)); }
}
const warmModules = (dependencies) => pageWarmer.warm(withGlue(dependencies));

const EMPTY_WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
export { ModuleWarmer, warmModules, pageWarmer, GRAPH, WARM_INTERVAL_MS, WARM_DEADLINE_MS, EMPTY_WASM };
