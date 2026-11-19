import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileShaderDocument, validateShaderDocument} from '../generated/shader/shader_workbench.mjs';
import {createChainDocumentStore, scratchChainDocument} from '../src/workbench/shader/chain_document_store.js';
import {createPresetTransport} from '../src/workbench/shader/chain_preset_transport.js';

const catalog = JSON.parse(readFileSync(new URL('../generated/shader/engine_catalog.json', import.meta.url)));
const sourceChain = [
  {label: 'project', operator: 'project.equirectangular.v2'},
  {label: 'paint', operator: 'sample.grid.v4'},
  {label: 'color', operator: 'colorize.generated-palette.v4'},
];

const fixture = () => scratchChainDocument(catalog, sourceChain);
const open = (document = fixture()) => createChainDocumentStore({document, catalog});
const first = 'catalog-defaults';
const bank = (store) => store.document().preset_bank;
const edges = (store) => bank(store).edges.map(({from, to, duration, easing}) => [from, to, duration, easing]);

test('bank edits preserve surviving edges and undo and redo the ring atomically', async () => {
  const store = await open();
  assert.equal(store.deletePreset(first).ok, false);
  assert.equal(store.canUndo(), false);
  const a = store.addPreset(first);
  assert.equal(a.ok, true);
  const b = store.duplicatePreset(a.presetId);
  assert.equal(b.ok, true);
  const {presetId: second} = a;
  const {presetId: third} = b;
  assert.equal(store.setPresetEdge(first, second, {duration: 63, easing: 'LINEAR'}).ok, true);
  assert.equal(store.renamePreset(second, 'Second').ok, true);
  assert.equal(bank(store).presets.find((preset) => preset.preset_id === second).display_name, 'Second');
  assert.deepEqual(edges(store), [
    [first, second, 63, 'LINEAR'], [second, third, 480, 'EASE_IN_OUT_SIN'], [third, first, 480, 'EASE_IN_OUT_SIN'],
  ]);
  assert.equal(store.movePreset(third, 1).ok, true);
  assert.deepEqual(bank(store).choreography.generated_order, [first, third, second]);
  assert.deepEqual(edges(store), [
    [first, third, 480, 'EASE_IN_OUT_SIN'], [third, second, 480, 'EASE_IN_OUT_SIN'], [second, first, 480, 'EASE_IN_OUT_SIN'],
  ]);
  const moved = store.document();
  assert.equal(store.undo(), true);
  assert.equal(edges(store)[0][2], 63);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.document(), moved);
  assert.equal(store.deletePreset(third).ok, true);
  assert.deepEqual(edges(store), [[second, first, 480, 'EASE_IN_OUT_SIN'], [first, second, 480, 'EASE_IN_OUT_SIN']]);
  assert.deepEqual(validateShaderDocument(store.exportDocument(), {catalog}), []);
});

test('off-rail edges remain available to review after dwell and bank edits', async () => {
  const seed = await open();
  const second = seed.addPreset(first).presetId;
  const third = seed.addPreset(second).presetId;
  const document = seed.document();
  document.preset_bank.edges.push({from: first, to: third, duration: 91, easing: 'LINEAR', path_policy: 'parallel'});
  const store = await open(document);
  assert.equal(store.setPresetDwell(second, 300).ok, true);
  assert.deepEqual(bank(store).choreography.dwell, {[first]: 600, [second]: 300, [third]: 600});
  assert.equal(store.setPresetDwell(second, 300, true).ok, true);
  assert.deepEqual(bank(store).choreography.dwell, {[first]: 300, [second]: 300, [third]: 300});
  assert.deepEqual(edges(store).at(-1), [first, third, 91, 'LINEAR']);
  assert.equal(store.undo(), true);
  assert.deepEqual(bank(store).choreography.dwell, {[first]: 600, [second]: 300, [third]: 600});
});

test('all-preset writes coalesce and a rejected batch leaves every value intact', async () => {
  const store = await open();
  const second = store.addPreset(first).presetId;
  assert.equal(store.setPresetValue(second, 'paint.pattern-freq', 3).ok, true);
  const before = store.document();
  assert.equal(store.setValuesInAllPresets({'paint.pattern-freq': 2}).ok, true);
  assert.equal(store.setValuesInAllPresets({'paint.pattern-freq': 5}).ok, true);
  assert.deepEqual(bank(store).presets.map(({values}) => values['paint.pattern-freq']), [5, 5]);
  assert.equal(store.setValuesInAllPresets({'paint.pattern-freq': 0}).ok, false);
  assert.deepEqual(bank(store).presets.map(({values}) => values['paint.pattern-freq']), [5, 5]);
  assert.equal(store.undo(), true);
  assert.deepEqual(store.document(), before);
});

test('a planar upgrade preserves installed values and a simplify restores the legacy digests', async () => {
  if (!catalog.operators.some((op) => op.id === 'sample.planar.v1')) {
    const grid = catalog.operators.find((op) => op.id === 'sample.grid.v4');
    const spiral = catalog.operators.find((op) => op.id === 'sample.spiral.v3');
    const localFields = ['edge-width', 'coverage-mode', 'weight-mode'];
    catalog.operators.push({...grid, id: 'sample.planar.v1', name: 'Planar Source', params: [
      {id: 'source', topology: true, blend: true, values: ['grid', 'spiral'], default: 'grid'},
      ...grid.params.filter((field) => localFields.includes(field.id)),
      ...[grid, spiral].flatMap((op) => {
        const family = op === grid ? 'grid' : 'spiral';
        return op.params.filter((field) => !localFields.includes(field.id)).map((field) => {
          const gated_by = field.gated_by ? {...field.gated_by, field: family + '-' + field.gated_by.field} : undefined;
          return {...field, id: family + '-' + field.id, sources: [family], gated_by};
        });
      }),
    ]});
  }
  const store = await open();
  const second = store.addPreset(first).presetId;
  assert.equal(store.setPresetValue(first, 'paint.pattern-freq', 2).ok, true);
  assert.equal(store.setPresetValue(second, 'paint.pattern-freq', 3).ok, true);
  const original = store.compile();
  assert.equal(store.setSourceKind('paint', second, 'spiral').ok, true);
  assert.equal(store.chain().find((entry) => entry.label === 'paint').operator, 'sample.planar.v1');
  assert.equal(store.presetValuesView(first)['paint.grid-pattern-freq'], 2);
  assert.equal(store.presetValuesView(second)['paint.grid-pattern-freq'], 3);
  assert.equal(store.presetValuesView(first)['paint.source'], 'grid');
  assert.equal(store.presetValuesView(second)['paint.source'], 'spiral');
  assert.equal(store.simplifySource('paint').ok, false);
  assert.equal(store.setPresetValue(second, 'paint.spiral-pattern-freq', 4).ok, true);
  assert.equal(store.setSourceKind('paint', first, 'spiral').ok, true);
  assert.equal(store.presetValuesView(first)['paint.spiral-pattern-freq'], 4);
  assert.equal(store.setSourceKind('paint', first, 'grid').ok, true);
  assert.equal(store.setSourceKind('paint', second, 'grid').ok, true);
  const exported = compileShaderDocument(store.exportDocument(), {catalog});
  assert.equal(exported.descriptor_digest, original.descriptor_digest);
  assert.equal(exported.preset_bank_digest, original.preset_bank_digest);
  assert.equal(store.simplifySource('paint').ok, true);
  assert.equal(store.undo(), true);
  assert.equal(store.presetValuesView(first)['paint.spiral-pattern-freq'], 4);
});

test('Next evaluates one frame at a time and adopts the destination after its final frame', () => {
  let preset = 'a';
  const events = [];
  const ab = {from: 'a', to: 'b', duration: 3, easing: 'LINEAR', path_policy: 'parallel'};
  const ba = {...ab, from: 'b', to: 'a'};
  const bank = {edges: [ab, ba], choreography: {generated_order: ['a', 'b'], dwell: {a: 3, b: 4}}};
  const transport = createPresetTransport({
    bank: () => bank, preset: () => preset,
    snap: (id) => { preset = id; return true; },
    adopt: (id) => { preset = id; events.push(['adopt', id]); },
    start: (edge) => { events.push(['start', edge.from, edge.to]); return true; },
    evaluate: (edge, frame, seek) => { events.push([edge.from, frame, seek]); return true; },
    update: () => {}, requestFrame: () => {},
  });
  transport.next();
  for (let frame = 1; frame <= 3; frame++) {
    transport.tick();
    assert.equal(transport.view().active.frame, frame);
    assert.equal(preset, 'a');
  }
  transport.tick();
  assert.equal(preset, 'b');
  assert.deepEqual(events, [['start', 'a', 'b'], ['a', 1, false], ['a', 2, false], ['a', 3, false], ['adopt', 'b']]);
  transport.selectEdge(ba);
  transport.seek(2);
  transport.tick();
  transport.tick();
  assert.deepEqual(events.slice(-1), [['b', 2, true]]);
  assert.equal(transport.view().active.frame, 2);
  transport.stop();
  assert.equal(transport.view().active, null);
});

test('Show waits for authored dwell and loops the neighbour rail', () => {
  let preset = 'a';
  const frames = [];
  const bank = {edges: [{from: 'a', to: 'b', duration: 1}, {from: 'b', to: 'a', duration: 1}],
    choreography: {generated_order: ['a', 'b'], dwell: {a: 2, b: 3}}};
  const transport = createPresetTransport({
    bank: () => bank, preset: () => preset,
    snap: () => true, adopt: (id) => { preset = id; }, start: () => true,
    evaluate: (edge) => { frames.push(edge.from); return true; },
    update: () => {}, requestFrame: () => {},
  });
  transport.show();
  transport.tick();
  assert.deepEqual(frames, []);
  transport.tick();
  assert.deepEqual(frames, ['a']);
  transport.tick();
  assert.equal(preset, 'b');
  transport.tick();
  assert.deepEqual(frames, ['a']);
  transport.tick();
  assert.deepEqual(frames, ['a', 'b']);
  transport.tick();
  assert.equal(preset, 'a');
  assert.equal(transport.view().showing, true);
});
