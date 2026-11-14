import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPath, folderSegment } from '../src/ui/deep_link_keys.js';

test('KeyPath preserves namespaces, display folders and sibling segments', () => {
  for (const namespace of [null, '', 'fx']) {
    const root = new KeyPath(namespace);
    const first = root.folder('Effects');
    const display = root.folder('Visual', true);
    const duplicate = root.folder('Effects');
    const unnamed = root.folder('');
    const visualEffects = display.folder('Effects');
    const nested = first.folder('Warp');
    const cases = [
      [root, 'speed', 'speed'],
      [first, 'speed', 'Effects.speed'],
      [display, 'speed', 'speed'],
      [duplicate, 'speed', 'Effects#2.speed'],
      [unnamed, 'speed', '#3.speed'],
      [visualEffects, 'speed', 'Effects.speed'],
      [nested, 'Planar Warp 1', 'Effects.Warp.Planar Warp 1'],
      [nested, '__accepted.Foo', 'Effects.Warp.__accepted.Foo'],
    ];
    root.folder('Effects');
    for (const [path, prop, suffix] of cases) {
      assert.equal(path.key(prop), namespace ? `${namespace}.${suffix}` : suffix);
    }
  }
  for (const [name, siblings, expected] of [
    ['A', [], 'A'], ['A', ['A'], 'A#1'], ['', ['A', null], '#2'],
    ['A#1', ['A', 'A#1'], 'A#1#2'], ['A', [null, 'B'], 'A'],
  ]) assert.equal(folderSegment(name, siblings), expected);
});
