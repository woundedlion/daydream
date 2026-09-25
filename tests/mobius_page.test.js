import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './page_handlers.js';
const handler = pageHandlers(new URL('../tools/mobius_page.js', import.meta.url));

test('animated snippets throttle formatting and flush the final stopped value', () => {
  let now = 0, formats = 0, lookups = 0;
  const output = { textContent: '' };
  const context = { isAnimating: true, lastCode: null, codeOutput: null, lastCodeTime: -Infinity,
    config: {}, performance: { now: () => now },
    document: { getElementById: () => { lookups++; return output; } },
    mobiusCodeString: () => String(++formats) };
  const update = handler('updateCodeSnippet', context);
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
