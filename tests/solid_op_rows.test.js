import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpRow } from '../tools/solid_op_rows.js';
import { OP_DEFS } from '../tools/solid_codegen.js';
import { fakeElement } from './fake_dom.js';

// fakeElement throws on any non-empty innerHTML assignment, so every assertion
// below also proves the row was assembled from nodes rather than from parsed
// markup — the property the op values (which survive a localStorage round-trip)
// depend on.
const doc = {
  createElement: (tag) => fakeElement(tag),
  createElementNS: (ns, tag) => {
    const el = fakeElement(tag);
    el.namespaceURI = ns;
    return el;
  },
};

/**
 * Builds a row with recording handlers.
 * @param {{op: string, params: Object}} op - The op to render.
 * @param {number} [index] - Position in the chain.
 * @param {number} [count] - Chain length.
 * @param {{params: Object}} [opDef] - Overrides the OP_DEFS lookup for a name the table has no entry for.
 * @returns {{el: Object, calls: Array<Array<*>>}} The row and the handler call log.
 */
function build(op, index = 0, count = 1, opDef = OP_DEFS[op.op]) {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const el = buildOpRow(op, index, {
    opDef,
    count,
    on: {
      startDrag: record('startDrag'),
      move: record('move'),
      remove: record('remove'),
      setParam: record('setParam'),
    },
    doc,
  });
  return { el, calls };
}

const textOf = (el, selector) => el.querySelector(selector).textContent;

test('a parameterless op renders a header and no parameter rows', () => {
  const { el } = build({ op: 'ambo', params: {} });
  assert.equal(textOf(el, '.font-bold'), '1. AMBO');
  assert.equal(el.querySelectorAll('.op-param').length, 0);
  assert.ok(el.querySelector('.drag-handle'), 'no drag grip');
  assert.equal(el.querySelector('.remove-op-btn').getAttribute('aria-label'),
    'Remove ambo at position 1');
});

test('an op name carrying markup lands as text, never as parsed markup', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { el } = build({ op: hostile, params: {} }, 0, 1, { params: {} });
  assert.equal(textOf(el, '.font-bold'), `1. ${hostile.toUpperCase()}`);
  assert.equal(el.querySelector('.remove-op-btn').getAttribute('aria-label'),
    `Remove ${hostile} at position 1`);
  assert.equal(el.querySelector('.move-op-up').getAttribute('aria-label'),
    `Move ${hostile} up`);
});

test('a parameter value carrying an attribute break lands on the input as a value', () => {
  const hostile = '0.3" autofocus onfocus="alert(1)';
  const { el } = build({ op: 'truncate', params: { t: hostile } });
  const [row] = el.querySelectorAll('.op-param');
  const range = row.children.find((c) => c.type === 'range');
  const number = row.children.find((c) => c.type === 'number');
  assert.equal(range.value, hostile, 'the slider lost the raw value');
  assert.equal(number.value, 'NaN', 'a non-numeric value reached the number box verbatim');
  // No node anywhere carries an event-handler attribute.
  for (const node of [el, ...el.querySelectorAll('.op-param'), range, number]) {
    for (const name of Object.keys(node.attributes)) {
      assert.doesNotMatch(name, /^on/i, `${name} is an inline handler attribute`);
    }
  }
});

test('parameter rows carry the OP_DEFS range and the current value', () => {
  const { el } = build({ op: 'snub', params: { t: 0.5, twist: 0.28 } });
  const rows = el.querySelectorAll('.op-param');
  assert.deepEqual(rows.map((r) => r.dataset.key), ['t', 'twist']);

  const [tRow, twistRow] = rows;
  const range = (row) => row.children.find((c) => c.type === 'range');
  const number = (row) => row.children.find((c) => c.type === 'number');
  assert.equal(range(tRow).min, 0.01);
  assert.equal(range(tRow).max, 0.99);
  assert.equal(range(tRow).step, 0.01);
  assert.equal(range(tRow).value, 0.5);
  assert.equal(number(twistRow).value, '0.28');
  assert.equal(number(twistRow).getAttribute('aria-label'), 'snub twist value');
  assert.equal(tRow.children[0].htmlFor, range(tRow).id);
});

test('the angle parameter is the one that carries a degree suffix', () => {
  const { el: hankin } = build({ op: 'hankin', params: { angle: 54 } });
  assert.equal(hankin.querySelectorAll('.op-param')[0].children.at(-1).textContent, 'deg');
  const { el: relax } = build({ op: 'relax', params: { iter: 100 } });
  assert.equal(relax.querySelectorAll('.op-param')[0].children.at(-1).textContent, '');
});

test('the chain ends disable the move button that would run off them', () => {
  const first = build({ op: 'kis', params: {} }, 0, 3).el;
  assert.equal(first.querySelector('.move-op-up').disabled, true);
  assert.equal(first.querySelector('.move-op-down').disabled, false);

  const last = build({ op: 'kis', params: {} }, 2, 3).el;
  assert.equal(last.querySelector('.move-op-up').disabled, false);
  assert.equal(last.querySelector('.move-op-down').disabled, true);

  const only = build({ op: 'kis', params: {} }, 0, 1).el;
  assert.equal(only.querySelector('.move-op-up').disabled, true);
  assert.equal(only.querySelector('.move-op-down').disabled, true);
});

test('the header buttons and grip call their handlers with the row index', () => {
  const { el, calls } = build({ op: 'kis', params: {} }, 1, 3);
  el.querySelector('.move-op-up').dispatch('click');
  el.querySelector('.move-op-down').dispatch('click');
  el.querySelector('.remove-op-btn').dispatch('click');
  el.querySelector('.drag-handle').dispatch('mousedown', { kind: 'mouse' });
  el.querySelector('.drag-handle').dispatch('touchstart', { kind: 'touch' });

  const grip = el.querySelector('.drag-handle');
  assert.deepEqual(calls.slice(0, 3), [
    ['move', 1, 0],
    ['move', 1, 2],
    ['remove', 1],
  ]);
  assert.deepEqual(
    calls.slice(3).map(([name, ev]) => [name, ev.kind, ev.target === grip]),
    [
      ['startDrag', 'mouse', true],
      ['startDrag', 'touch', true],
    ],
  );
});

test('both parameter inputs report edits, and neither starts a row drag', () => {
  const { el, calls } = build({ op: 'truncate', params: { t: 0.33 } }, 2, 4);
  const [row] = el.querySelectorAll('.op-param');
  const range = row.children.find((c) => c.type === 'range');
  const number = row.children.find((c) => c.type === 'number');

  range.dispatch('input', { target: { value: '0.4' } });
  number.dispatch('change', { target: { value: '0.45' } });
  assert.deepEqual(calls, [['setParam', 2, 't', '0.4'], ['setParam', 2, 't', '0.45']]);

  let stopped = 0;
  const mousedown = { stopPropagation: () => { stopped++; } };
  range.dispatch('mousedown', mousedown);
  number.dispatch('mousedown', mousedown);
  assert.equal(stopped, 2, 'an input drag would start the row reorder');
});

test('the drag grip is built as namespaced SVG nodes, not markup', () => {
  const { el } = build({ op: 'kis', params: {} });
  const svg = el.querySelector('.drag-handle').children[0];
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
  const path = svg.children[0];
  assert.equal(path.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.match(path.getAttribute('d'), /^M11 18c0 1\.1/);
});
