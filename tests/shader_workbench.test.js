import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shaderWorkbenchUrl } from '../daydream.js';
import {
  findWorkbenchFolder,
  revealWorkbenchFolder,
} from '../tools/shader_workbench_nav.js';

const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WORKBENCH = readFileSync(new URL('../tools/shader.html', import.meta.url), 'utf8');
const WORKBENCH_CSS = readFileSync(new URL('../tools/shader.css', import.meta.url), 'utf8');

test('simulator exposes Shader as a standalone tool', () => {
  assert.match(INDEX, /href="tools\/shader\.html"[^>]*>Shader/);
  assert.match(WORKBENCH, /data-daydream-mode="shader-workbench"/);
  assert.match(WORKBENCH, /src="\.\.\/main\.js"/);
  assert.match(WORKBENCH, /id="shader-workbench-nav"/);
  assert.match(WORKBENCH, /src="shader_workbench_nav\.js"/);
  assert.doesNotMatch(WORKBENCH, />Simulator<\/a>/);
  assert.doesNotMatch(WORKBENCH, /id="effect-sidebar"/);
  assert.match(WORKBENCH_CSS, /\.lil-controller\.lil-option option\s*\{/);
  assert.match(WORKBENCH_CSS, /color-scheme:\s*dark/);
  assert.match(WORKBENCH_CSS, /background-color:\s*var\(--background-color\)/);
});

test('stage navigation opens and reveals the selected GUI folder', () => {
  let clicked = false;
  let scrolled = false;
  const title = {
    textContent: 'Projection',
    click: () => { clicked = true; },
    getAttribute: () => 'false',
  };
  const folder = {
    querySelector: () => title,
    scrollIntoView: () => { scrolled = true; },
  };
  title.parentElement = folder;
  const root = { querySelectorAll: () => [{ textContent: 'Camera' }, title] };

  assert.equal(findWorkbenchFolder(root, 'Projection'), folder);
  assert.equal(revealWorkbenchFolder(root, 'Projection'), true);
  assert.equal(clicked, true);
  assert.equal(scrolled, true);
  assert.equal(revealWorkbenchFolder(root, 'Missing'), false);
});

test('legacy custom Shader URLs preserve their state on the workbench route', () => {
  assert.equal(
    shaderWorkbenchUrl('https://example.test/daydream/index.html?effect=ShaderBall&fx.Speed=2#preview'),
    '/daydream/tools/shader.html?effect=Shader&fx.Speed=2#preview',
  );
});
