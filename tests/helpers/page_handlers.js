import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'espree';

/**
 * @param {URL} url Page module to inspect.
 * @returns {(name: string, context: object) => Function} Named callable extractor.
 */
export function pageHandlers(url) {
  const source = readFileSync(url, 'utf8');
  const parsed = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  return (name, context) => {
    let declaration;
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'FunctionDeclaration' && node.id?.name === name) declaration = node;
      if (node.type === 'VariableDeclarator' && node.id?.name === name
          && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
        declaration = node.init;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(parsed);
    assert.ok(declaration, `missing handler ${name}`);
    return runInNewContext(`"use strict"; (${source.slice(...declaration.range)})`, context);
  };
}
