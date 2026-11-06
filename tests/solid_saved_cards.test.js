import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSavedCard} from '../src/workbench/solids/solid_saved_cards.js';
import {fakeElement, stashGlobals} from './helpers/fake_dom.js';

const doc = {createElement: fakeElement};
const noop = () => {};
const actions = {restore: noop, remove: noop, copy: noop, explain: noop};
const options = {count: 5, funcName: 'cube_kis', clashMessage: '', canRestore: true, on: actions, doc};

test('saved cards render hostile metadata as text and wire each named action', () => {
  const item = {title: '<img src=x onerror=alert(1)>', stats: 'V8', desc: '<script>x</script>',
    thumb: 'data:image/png;base64,thumbnail'};
  const calls = [];
  const card = buildSavedCard(item, 2, {...options, on: {
    restore: value => calls.push(['restore', value]), remove: index => calls.push(['remove', index]),
    copy: (...args) => calls.push(['copy', ...args]), explain: assert.fail,
  }});
  assert.equal(card.querySelector('.title').textContent, item.title);
  assert.equal(card.querySelector('.saved-stats').textContent, 'V8');
  assert.equal(card.querySelector('.details').textContent, item.desc);
  assert.equal(card.querySelector('img').src, item.thumb);
  assert.equal(card.querySelector('img').alt, '');
  const restore = card.querySelector('.saved-restore');
  assert.equal(restore.disabled, false);
  restore.dispatch('click');
  assert.equal(calls[0][0], 'restore');
  assert.ok(calls[0][1] === item);
  const remove = card.querySelector('.del-btn');
  assert.equal(remove.getAttribute('aria-label'), 'Delete cube_kis (card 3)');
  remove.dispatch('click');
  assert.deepEqual(calls[1], ['remove', 2]);
  for (const [index, kind, label] of [[2, 'recipe_cpp', 'recipe'], [3, 'registry', 'registry']]) {
    const button = card.querySelectorAll('[data-copy]').find(button => button.dataset.copy === kind);
    assert.equal(button.getAttribute('aria-label'), `Copy ${label} C++ for cube_kis (card 3)`);
    button.dispatch('click');
    assert.deepEqual(calls[index].slice(0, 3), ['copy', 2, kind]);
    assert.ok(calls[index][3] === button);
  }
  assert.equal(card.classList.contains('name-clash'), false);
  assert.equal(card.querySelector('.saved-clash-btn'), null);
});

test('collision badges expose their explanation and cards fall back to their title', () => {
  const messages = [];
  const message = 'Exports as cube_kis, which another saved solid also exports';
  const card = buildSavedCard({title: 'Saved cube'}, 0, {...options,
    funcName: null, clashMessage: message, canRestore: false,
    on: {...actions, explain: text => messages.push(text)},
  });
  assert.equal(card.classList.contains('name-clash'), true);
  assert.equal(card.title, message);
  const badge = card.querySelector('.saved-clash-btn');
  assert.equal(badge.type, 'button');
  assert.equal(badge.classList.contains('text-amber-400'), true);
  assert.equal(badge.getAttribute('aria-label'), message);
  badge.dispatch('click');
  assert.deepEqual(messages, [message]);
  assert.equal(card.querySelector('.saved-restore').disabled, true);
  assert.equal(card.querySelector('.del-btn').getAttribute('aria-label'), 'Delete Saved cube (card 5)');
});

test('only image data thumbnails are assigned and absent metadata stays empty', () => {
  for (const thumb of [undefined, null, 7, 'https://example.test/image.png', 'javascript:x']) {
    const card = buildSavedCard({thumb}, 0, options);
    assert.equal(card.querySelector('img').src, undefined);
    for (const selector of ['.title', '.saved-stats', '.details'])
      assert.equal(card.querySelector(selector).textContent, '');
  }
});

test('the saved card builder can use the ambient document at call time', (t) => {
  t.after(stashGlobals('document'));
  globalThis.document = doc;
  const ambient = {...options};
  delete ambient.doc;
  assert.equal(buildSavedCard({title: 'Cube'}, 0, ambient).querySelector('.title').textContent, 'Cube');
});
