import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'espree';

test('animated snippets throttle formatting and flush the final stopped value', () => {
  const source = readFileSync(new URL('../tools/mobius_page.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  const expression = ast.body.find((node) => node.declarations?.[0].id.name === 'updateCodeSnippet')
    .declarations[0].init;
  let now = 0, formats = 0, lookups = 0;
  const output = { textContent: '' };
  const context = { isAnimating: true, lastCode: null, codeOutput: null, lastCodeTime: -Infinity,
    config: {}, performance: { now: () => now },
    document: { getElementById: () => { lookups++; return output; } },
    mobiusCodeString: () => String(++formats) };
  const update = runInNewContext(`(${source.slice(...expression.range)})`, context);
  update();
  now = 16;
  update();
  now = 100;
  update();
  assert.equal(formats, 2);
  assert.equal(lookups, 1);
  context.isAnimating = false;
  now = 101;
  update();
  assert.equal(output.textContent, '3');
});
