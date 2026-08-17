import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shaderWorkbenchUrl, start } from '../daydream.js';
import {
  findWorkbenchFolder,
  revealWorkbenchFolder,
} from '../tools/shader_workbench_nav.js';
import {
  applyDynamicShaderDocument,
  engineParameterName,
} from '../tools/shader_documents.js';
import { ParamSetResult } from './fake_engine.js';

const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WORKBENCH = readFileSync(new URL('../tools/shader.html', import.meta.url), 'utf8');
const WORKBENCH_CSS = readFileSync(new URL('../tools/shader.css', import.meta.url), 'utf8');

test('simulator exposes Shader as a standalone tool', () => {
  assert.match(INDEX, /href="tools\/shader\.html"[^>]*>Shader/);
  assert.match(WORKBENCH, /data-daydream-mode="shader-workbench"/);
  assert.match(WORKBENCH, /src="\.\.\/main\.js"/);
  assert.match(WORKBENCH, /id="shader-workbench-nav"/);
  assert.match(WORKBENCH, /id="shader-document-select"/);
  assert.match(WORKBENCH, /id="shader-preset-select"/);
  assert.match(WORKBENCH, /id="shader-document-open"/);
  assert.match(WORKBENCH, /id="shader-document-save"/);
  assert.match(WORKBENCH, /src="shader_workbench_nav\.js"/);
  assert.doesNotMatch(WORKBENCH, />Simulator<\/a>/);
  assert.doesNotMatch(WORKBENCH, /id="effect-sidebar"/);
  assert.match(WORKBENCH_CSS, /\.lil-controller\.lil-option option\s*\{/);
  assert.match(WORKBENCH_CSS, /color-scheme:\s*dark/);
  assert.match(WORKBENCH_CSS, /background-color:\s*var\(--background-color\)/);
});

test('document parameter IDs map to dynamic stage controls', () => {
  assert.equal(engineParameterName('pattern-freq'), 'Pattern Freq');
  assert.equal(engineParameterName('outer-cell-x'), 'Planar Warp 1 Cell X');
  assert.equal(engineParameterName('inner-speed'), 'Planar Warp 2 Speed');
  assert.equal(engineParameterName('edge-width'), 'Edge Fade Width');
  assert.equal(engineParameterName('source-angle-speed'), 'Source Angle Speed');
});

const MODULE = { ParamSetResult };

const dynamicDefinitions = () => [
  { name: 'Function', options: ['Grid'] },
  { name: 'Projection', options: ['Stereographic'] },
  { name: 'Surface Noise', options: ['None'] },
  { name: 'Lens', options: ['None'] },
  { name: 'Planar Warp 1', options: ['None'] },
  { name: 'Planar Warp 2', options: ['None'] },
  { name: 'Signal Weight', options: ['Projection'] },
  { name: 'Value Transfer', options: ['Linear'] },
  { name: 'Coverage', options: ['Opaque'] },
  { name: 'Palette', options: ['Generated Triadic'] },
  { name: 'Hue Shift Mode', options: ['Noise'] },
  { name: 'Brightness Envelope', options: ['None'] },
  { name: 'Pattern Freq' },
];

const dynamicDocument = () => ({ document: {
  descriptor: { graph: { nodes: [
    { role: 'surface_project', policy: {
      pre_lens_surface: 'identity', lens: 'identity', projection: 'stereographic',
    } },
    { role: 'planar_warp', policy: { sequence: ['identity', 'identity'] } },
    { role: 'source', policy: { source: 'grid' } },
    { role: 'material', policy: {
      weight: 'projection', transfer: 'linear', coverage: 'opaque',
    } },
    { role: 'color', policy: {
      color: 'generated-palette', hue_mode: 'noise', brightness_envelope: 'none',
    } },
  ] } },
  preset_bank: { presets: [{ preset_id: 'study', values: { 'pattern-freq': 3.5 } }] },
} });

/** @param {(name: string) => Object} answer */
function dynamicEngine(answer) {
  const definitions = dynamicDefinitions();
  const writes = [];
  return {
    writes,
    getParameterDefinitions: () => definitions,
    setParameter: (name, value) => { writes.push([name, value]); return answer(name); },
  };
}

test('dynamic document preview snaps structure before applying preset values', () => {
  const engine = dynamicEngine(() => ParamSetResult.APPLIED);

  assert.equal(
    applyDynamicShaderDocument(engine, MODULE, dynamicDocument(), 'study'), null);
  assert.deepEqual(engine.writes.at(-1), ['Pattern Freq', 3.5]);
  assert.equal(engine.writes.find(([name]) => name === 'Function')?.[1], 0);
});

// Every ParamSetResult value is a truthy object, so a refused write only reads as
// refused against APPLIED; a preview that missed one would bake into a Save.
test('a refused parameter write reports the parameter and the engine outcome', () => {
  const engine = dynamicEngine((name) =>
    (name === 'Pattern Freq' ? ParamSetResult.READONLY : ParamSetResult.APPLIED));

  const refusal = applyDynamicShaderDocument(
    engine, MODULE, dynamicDocument(), 'study');
  assert.equal(typeof refusal, 'string');
  assert.match(refusal, /Pattern Freq/);
  assert.match(refusal, /READONLY/);
});

test('a refused structural write stops before the preset values', () => {
  const engine = dynamicEngine((name) =>
    (name === 'Lens' ? ParamSetResult.UNKNOWN_PARAM : ParamSetResult.APPLIED));

  const refusal = applyDynamicShaderDocument(
    engine, MODULE, dynamicDocument(), 'study');
  assert.match(refusal, /"Lens" was refused: UNKNOWN_PARAM/);
  assert.deepEqual(engine.writes.at(-1), ['Lens', 0]);
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

test('the workbench route carries the requested shader document', () => {
  assert.equal(
    shaderWorkbenchUrl('https://example.test/daydream/index.html?effect=signal-weave', 'signal-weave'),
    '/daydream/tools/shader.html?effect=signal-weave',
  );
});

// A document id is a workbench effect the simulator's favorites never list, so
// without the route it fails validation and the page opens on its default.
test('a shader-document deep link routes the simulator to the workbench', () => {
  const replaced = [];
  const win = {
    location: { href: 'https://example.test/daydream/index.html?effect=alien-ocean',
                search: '?effect=alien-ocean',
                replace: (url) => replaced.push(url) },
    addEventListener() {}, removeEventListener() {},
  };
  const doc = { documentElement: { dataset: {} } };
  start({ doc, win });
  assert.deepEqual(replaced, ['/daydream/tools/shader.html?effect=alien-ocean']);
});
