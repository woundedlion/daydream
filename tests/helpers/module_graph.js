//
// The static import graph of a repo module, read from source text. Shared by
// the suites that pin what the segment worker pulls in: the graph it resolves
// on its own, and the set the page warms ahead of a spawn.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Static import/export-from specifiers of one module source. Dynamic `import()`
 * is out of scope: it resolves when it runs, and the generated WASM glue guards
 * a node-only one behind an environment check the worker never takes.
 * @param {string} source - Module source text.
 * @returns {string[]} Specifiers, in source order.
 */
export function staticSpecifiers(source) {
  const specs = [];
  // Statement-anchored so a specifier-shaped string inside minified code is not
  // read as an import; the bounded gap spans a multi-line import clause.
  for (const m of source.matchAll(
    /^[ \t]*(?:import|export)[ \t][\s\S]{0,400}?from[ \t]*['"]([^'"]+)['"]/gm)) {
    specs.push(m[1]);
  }
  for (const m of source.matchAll(/^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm)) {
    specs.push(m[1]);
  }
  return specs;
}

/**
 * Walks a module's static import graph. Only a relative specifier is followed;
 * a bare one is recorded as an edge and left unresolved, so the caller decides
 * whether it is a defect.
 * @param {string} entry - Repo-relative, forward-slashed module path.
 * @returns {{modules: string[], edges: Array<{from: string, specifier: string}>}}
 *   Every module reached, sorted, and every static import found on the way.
 */
export function staticModuleGraph(entry) {
  const reached = new Set();
  const edges = [];
  const walk = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    const source = readFileSync(join(REPO, file), 'utf8');
    for (const specifier of staticSpecifiers(source)) {
      edges.push({ from: file, specifier });
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        walk(posix.normalize(posix.join(posix.dirname(file), specifier)));
      }
    }
  };
  walk(entry);
  return { modules: [...reached].sort(), edges };
}
