//
// Module-resolution hooks, registered with module.register(). They redirect
// three and its OrbitControls addon to the fake for every importer in the
// process, so tools/shared.js gets the fake whichever file pulls it in. Each
// test file gets its own process, so the redirect never leaks into another
// suite.
const REDIRECTED = new Set([
  'three',
  'three/addons/controls/OrbitControls.js',
]);

let fakeThreeUrl = '';

/** @param {{fakeThreeUrl: string}} data - The URL the redirected specifiers resolve to. */
export function initialize(data) {
  fakeThreeUrl = data.fakeThreeUrl;
}

/**
 * @param {string} specifier - The imported specifier.
 * @param {Object} context - The resolution context.
 * @param {Function} nextResolve - The next hook in the chain.
 * @returns {Object} The resolution result.
 */
export function resolve(specifier, context, nextResolve) {
  if (REDIRECTED.has(specifier)) {
    return { url: fakeThreeUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
