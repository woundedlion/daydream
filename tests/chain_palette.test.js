import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createChainPalette} from '../src/workbench/shader/chain_palette.js';
import {fakeElement, installDocument, restoreDocumentAfterEach} from './helpers/fake_dom.js';

restoreDocumentAfterEach();

function paletteFixture() {
  const doc = installDocument({activeElement: null, createElement: fakeElement});
  const container = fakeElement('section', {connected: true});
  const anchor = fakeElement('button');
  anchor.setAttribute('aria-haspopup', 'listbox');
  container.appendChild(anchor);
  const operator = {id: 'warp.test', name: 'Test warp'};
  const chain = [];
  const announcements = [];
  const commits = [];
  const refusals = [];
  const pinnedLabels = new Set();
  let legal = true;
  let accepted = true;
  const palette = createChainPalette({doc,
    el: (tag, classes) => { const node = fakeElement(tag); node.className = classes; return node; },
    store: {
      chain: () => chain,
      legalInsertions: () => [{operator, legal, ...(legal ? {} : {reason: 'blocked'})}],
      replaceSpan: (start, deleteCount, entries) => {
        if (!accepted) return {ok: false, diagnostics: [{message: 'blocked'}]};
        chain.push(...entries);
        return {ok: true};
      },
      setSelectedLabel: () => true,
    },
    presentation: {choiceEntries: () => [{label: 'new-warp', operator: operator.id}]},
    commit: label => { commits.push(label); return true; },
    report: result => { refusals.push(result); return false; },
    announce: message => announcements.push(message), pinnedLabels,
  });
  return {palette, anchor, container, doc, announcements, commits, refusals, pinnedLabels,
    setLegal: value => { legal = value; }, setAccepted: value => { accepted = value; }};
}

test('palette insertion reports refusals and commits the accepted operator', () => {
  const h = paletteFixture();
  h.palette.open({kind: 'insert', index: 0, anchor: h.anchor});
  assert.equal(h.palette.anchor(), h.anchor);
  assert.equal(h.anchor.getAttribute('aria-expanded'), 'true');
  const option = h.container.querySelector('.chain-palette-entry');
  h.setAccepted(false);
  option.dispatch('click');
  assert.equal(h.refusals.length, 1);
  assert.deepEqual(h.commits, []);
  assert.equal(h.palette.anchor(), h.anchor);
  h.setAccepted(true);
  option.dispatch('click');
  assert.deepEqual(h.commits, ['new-warp']);
  assert.equal(h.pinnedLabels.has('new-warp'), true);
  assert.equal(h.palette.anchor(), null);
});

test('palette dismissal preserves its anchor focus and ignores inside presses', () => {
  const h = paletteFixture();
  h.palette.open({kind: 'insert', index: 0, anchor: h.anchor});
  h.palette.pointerDown({target: h.anchor});
  assert.equal(h.palette.anchor(), h.anchor);
  const element = h.container.querySelector('.chain-palette');
  element.dispatch('keydown', {key: 'Escape'});
  assert.equal(h.palette.anchor(), null);
  assert.equal(h.doc.activeElement, h.anchor);
  assert.equal(h.anchor.getAttribute('aria-expanded'), 'false');
  h.palette.open({kind: 'insert', index: 0, anchor: h.anchor});
  h.palette.pointerDown({target: fakeElement('div')});
  assert.equal(h.container.querySelector('.chain-palette'), null);
});

test('an empty legal palette announces its refusal without opening', () => {
  const h = paletteFixture();
  h.setLegal(false);
  h.palette.open({kind: 'insert', index: 0, anchor: h.anchor});
  assert.equal(h.palette.anchor(), null);
  assert.deepEqual(h.announcements, ['No legal operators are available here.']);
});
