import assert from 'node:assert/strict';

/**
 * Rewrite two-argument constructors as complex object literals.
 * @param {string} text - Source fragment.
 * @param {string} ctorName - Constructor name.
 * @returns {string} Rewritten fragment.
 */
export function constructorToObject(text, ctorName) {
  let source = text;
  let at = 0;
  while ((at = source.indexOf(`${ctorName}(`, at)) !== -1) {
    const open = at + ctorName.length;
    let depth = 0, comma = -1, close = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')' && (depth -= 1) === 0) { close = i; break; }
      else if (source[i] === ',' && depth === 1) comma = i;
    }
    assert.ok(comma > open && close > comma,
      `unreadable ${ctorName}(...) at "${source.slice(at, at + 60)}"`);
    source = `${source.slice(0, at)}({ re: (${source.slice(open + 1, comma)}), `
      + `im: (${source.slice(comma + 1, close)}) })${source.slice(close + 1)}`;
    at = 0;
  }
  return source;
}

/**
 * Evaluate GLSL float constants as a JavaScript preamble.
 * @param {string} src - GLSL source.
 * @returns {{js: string, values: Object<string, number>}} Preamble and values.
 */
export function glslConstants(src) {
  const decls = [...src.matchAll(/const\s+float\s+(\w+)\s*=\s*([^;]+);/g)];
  const js = decls.map(([, name, value]) => `const ${name} = ${value};`).join('\n');
  const names = decls.map(([, name]) => name);
  const values = new Function(`${js}\nreturn { ${names.join(', ')} };`)();
  return { js, values };
}
