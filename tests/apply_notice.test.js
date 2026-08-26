//
// The shared notice element: several subsystems announce through the one
// element, so ownership decides whose message a clear drops, and the live
// region has to be exposed before its text is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeElement } from './fake_dom.js';
import { fakeScheduler } from './fake_timers.js';
import { createApplyNotice } from '../apply_notice.js';

// The shared notice element: the parameter writer and the switch coordinator
// both announce through it, so ownership decides whose message a clear drops.

// Pins the ids the sink itself asks the document for against the real markup: a
// rename on either side swallows every rejection message behind a single
// warning. The ids are recorded from the lookup rather than restated here, so a
// renamed query cannot pass by matching a stale literal.
test('index provides every apply-notice element the sink resolves', () => {
  const queried = [];
  const byId = new Map();
  const timer = fakeScheduler();
  const notice = createApplyNotice({
    doc: {
      getElementById: (id) => {
        queried.push(id);
        if (!byId.has(id)) byId.set(id, fakeElement('div'));
        return byId.get(id);
      },
    },
    schedule: timer.schedule,
    cancel: timer.cancel,
  });

  notice.show('Effect change was rejected.', 'switch'); // the write drives the lookup

  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(queried.length > 0, 'the sink resolved nothing, so nothing is pinned');
  for (const id of queried)
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
});

/**
 * Build the notice sink over fake notice elements and a timer the test fires by
 * hand.
 * @returns {Object} The sink, the two elements, and the pending timeout.
 */
function makeApplyNotice() {
  const body = fakeElement('div');
  const text = fakeElement('span');
  const dismiss = fakeElement('button');
  body.append(text, dismiss); // index.html nests both inside the body
  body.hidden = true; // index.html renders apply-notice-body hidden
  const timer = fakeScheduler();
  const doc = {
    activeElement: null,
    getElementById: (id) => ({
      'apply-notice-body': body,
      'apply-notice-text': text,
      'apply-notice-dismiss': dismiss,
    }[id] ?? null),
  };
  const notice = createApplyNotice({
    doc,
    timeoutMs: 8000,
    schedule: timer.schedule,
    cancel: timer.cancel,
  });
  return {
    notice,
    doc,
    body,
    text,
    dismiss,
    timer,
    expire: timer.fire,
  };
}

test('a document without the notice elements is reported once, not swallowed', () => {
  const warnings = [];
  const present = {};
  const timer = fakeScheduler();
  const notice = createApplyNotice({
    doc: { getElementById: (id) => present[id] ?? null },
    schedule: timer.schedule,
    cancel: timer.cancel,
    logWarning: (message) => warnings.push(message),
  });

  notice.show('Effect change was rejected.', 'switch');
  notice.show('Parameter "spin" was rejected.', 'param');

  assert.equal(warnings.length, 1, 'the absence is named once, not once per write');
  assert.match(warnings[0], /apply-notice-body/);
  assert.match(warnings[0], /apply-notice-text/);
  assert.equal(notice.owner(), null);

  // The sink re-queries, so markup that arrives later still gets its notices.
  present['apply-notice-body'] = fakeElement('div');
  present['apply-notice-text'] = fakeElement('span');
  notice.show('Effect change was rejected.', 'switch');

  assert.equal(present['apply-notice-text'].textContent, 'Effect change was rejected.');
  assert.equal(present['apply-notice-body'].hidden, false);
  assert.equal(notice.owner(), 'switch');
  assert.equal(warnings.length, 1);
});

test('the live region is unhidden before its text is written', () => {
  const h = makeApplyNotice();
  const writes = [];
  let stored = '';
  Object.defineProperty(h.text, 'textContent', {
    get: () => stored,
    set(value) { stored = value; writes.push({ value, hidden: h.body.hidden }); },
  });

  h.notice.show('Effect change was rejected.', 'switch');
  // Hidden content is outside the accessibility tree: a write followed by the
  // unhide leaves the unhide as the only mutation assistive tech sees.
  assert.deepEqual(writes, [{ value: 'Effect change was rejected.', hidden: false }]);

  h.notice.show(null, 'switch');
  assert.deepEqual(writes[1], { value: '', hidden: true },
    'a clear hides the region before emptying it, so nothing is re-announced');
});

test('a param write does not clear a notice the switch coordinator raised', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.notice.show(null, 'param');

  assert.equal(h.text.textContent, 'Effect change was rejected.',
    'a slider nudge after a rejected switch must not erase the only '
    + 'explanation the user was given');
  assert.equal(h.body.hidden, false);
  assert.equal(h.notice.owner(), 'switch');
});

test('a raised notice takes the element over from another owner', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.notice.show('Parameter "spin" was rejected.', 'param');

  assert.equal(h.text.textContent, 'Parameter "spin" was rejected.');
  assert.equal(h.notice.owner(), 'param');
  assert.deepEqual(h.timer.cancelled, [1],
    "the displaced owner's self-clear must not fire against the new message");
});

test('an owner clears the notice it raised', () => {
  const h = makeApplyNotice();

  h.notice.show('Parameter "spin" was rejected.', 'param');
  h.notice.show(null, 'param');

  assert.equal(h.text.textContent, '');
  assert.equal(h.body.hidden, true);
  assert.equal(h.notice.owner(), null, 'a cleared element is owned by nobody');
});

test('clearing an already-clear notice writes neither element', () => {
  const h = makeApplyNotice();
  const writes = [];
  let hidden = h.body.hidden;
  Object.defineProperty(h.body, 'hidden', {
    get: () => hidden,
    set(value) { hidden = value; writes.push('hidden'); },
  });
  let stored = h.text.textContent;
  Object.defineProperty(h.text, 'textContent', {
    get: () => stored,
    set(value) { stored = value; writes.push('text'); },
  });

  h.notice.show(null, 'param');
  h.notice.show(null, 'param');

  assert.deepEqual(writes, [],
    'an accepted parameter write clears the notice per pointermove across a '
    + 'slider drag, and an unchanged hidden attribute still invalidates style');
});

test('a clear on an unowned element hides it rather than crashing', () => {
  const h = makeApplyNotice();
  // A notice on screen that no owner is recorded for, as a reload of a page
  // whose markup already carried one leaves it.
  h.body.hidden = false;
  h.text.textContent = 'Effect change was rejected.';

  h.notice.show(null, 'param');

  assert.equal(h.body.hidden, true, 'an unowned clear left the notice on screen');
  assert.equal(h.text.textContent, '');
  assert.equal(h.notice.owner(), null);
});

test('the notice self-clears so a stale rejection cannot outlive its action', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  assert.equal(h.timer.ms, 8000);
  h.expire();

  assert.equal(h.text.textContent, '');
  assert.equal(h.body.hidden, true);
  assert.equal(h.notice.owner(), null);
});

test('the self-clear waits out keyboard focus inside the notice', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.doc.activeElement = h.dismiss;
  h.expire();

  assert.equal(h.body.hidden, false,
    'hiding the body drops focus from the dismiss button the user is standing on');
  assert.equal(h.notice.owner(), 'switch');
  assert.equal(h.timer.ms, 8000, 'the dwell is served again');

  // The button is still the user's own way out, deferred dwell or not.
  h.notice.clear();
  assert.equal(h.body.hidden, true);

  h.notice.show('Effect change was rejected.', 'switch');
  h.doc.activeElement = null;
  h.expire();
  assert.equal(h.body.hidden, true);
  assert.equal(h.notice.owner(), null);
});

test('the dismiss button and the teardown clear whoever raised the notice', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.notice.clear();

  assert.equal(h.text.textContent, '');
  assert.equal(h.body.hidden, true);
  assert.deepEqual(h.timer.cancelled, [1], 'the pending self-clear is cancelled');
});

test('the notice tolerates a page missing the element', () => {
  const notice = createApplyNotice({
    doc: { getElementById: () => null },
    logWarning: () => {},
  });

  notice.show('Effect change was rejected.', 'switch');
  notice.clear();

  assert.equal(notice.owner(), null);
});
