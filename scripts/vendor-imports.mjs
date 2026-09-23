import { parse } from 'espree';

/**
 * @param {string} src - JavaScript source or HTML containing inline scripts.
 * @param {string} file - Source filename for parsing and diagnostics.
 * @returns {string[]} Imported paths below three/addons/.
 * @throws {Error} When a module specifier cannot be audited statically.
 */
export function vendorAddonsFromSource(src, file) {
  const found = new Set();
  const sources = file.endsWith('.html')
    ? [...src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter((match) => !/type\s*=\s*['"](?:importmap|application\/json)['"]/i.test(match[1]))
      .map((match) => match[2])
    : [src];
  let localUrls;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (['ImportExpression', 'ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)
        && node.source) {
      if (node.source.type === 'Identifier' && localUrls.has(node.source.name)) return;
      if (node.source.type !== 'Literal' || typeof node.source.value !== 'string')
        throw new Error(`${file}: module imports must use literal specifiers so vendor integrity is complete`);
      const name = node.source.value;
      if (name.startsWith('three/addons/')) found.add(name.slice('three/addons/'.length));
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  for (const body of sources) {
    const ast = parse(body, { ecmaVersion: 'latest', sourceType: 'module' });
    localUrls = new Set();
    for (const node of ast.body) {
      if (node.type !== 'VariableDeclaration' || node.kind !== 'const') continue;
      for (const declaration of node.declarations) {
        const member = declaration.init;
        const call = member?.object;
        if (declaration.id.type === 'Identifier' && member?.type === 'MemberExpression'
            && member.property.name === 'href' && call?.type === 'NewExpression'
            && call.callee.name === 'URL' && call.arguments[0]?.type === 'Literal'
            && /^\.\.?\//.test(call.arguments[0].value)
            && call.arguments[1]?.type === 'MemberExpression'
            && call.arguments[1].object.type === 'MetaProperty'
            && call.arguments[1].property.name === 'url') localUrls.add(declaration.id.name);
      }
    }
    visit(ast);
  }
  return [...found].sort();
}
