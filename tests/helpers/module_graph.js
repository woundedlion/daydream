//
// The static import graph of a repo module, read from source text.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'espree';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Static import/export-from specifiers of one module source; dynamic `import()`
 * is not collected.
 * @param {string} source - Module source text.
 * @returns {string[]} Specifiers, in source order.
 */
export function staticSpecifiers(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .filter((node) => ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)
      && node.source)
    .map((node) => node.source.value);
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
