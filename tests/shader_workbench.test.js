import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shaderWorkbenchUrl } from '../daydream.js';

const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WORKBENCH = readFileSync(new URL('../tools/shader.html', import.meta.url), 'utf8');

test('simulator exposes Shader as a standalone tool', () => {
  assert.match(INDEX, /href="tools\/shader\.html"[^>]*>Shader/);
  assert.match(WORKBENCH, /data-daydream-mode="shader-workbench"/);
  assert.match(WORKBENCH, /src="\.\.\/main\.js"/);
  assert.doesNotMatch(WORKBENCH, /id="effect-sidebar"/);
});

test('legacy custom Shader URLs preserve their state on the workbench route', () => {
  assert.equal(
    shaderWorkbenchUrl('https://example.test/daydream/index.html?effect=ShaderBall&fx.Speed=2#preview'),
    '/daydream/tools/shader.html?effect=Shader&fx.Speed=2#preview',
  );
});
