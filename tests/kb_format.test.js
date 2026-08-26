import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatKB } = await import('../tools/kb_format.js');

/** The stat bars read bytes; the divisor is 1024, not 1000. */
test('formatKB: divides bytes by 1024', () => {
  assert.equal(formatKB(1024), '1.0');
  assert.equal(formatKB(2560), '2.5');
  assert.equal(formatKB(0), '0.0');
});

/** One fractional digit unless the caller asks for another width. */
test('formatKB: defaults to one fractional digit', () => {
  assert.equal(formatKB(1536), '1.5');
  assert.equal(formatKB(1536, 0), '2');
  assert.equal(formatKB(1536, 2), '1.50');
});

/** Capacities are shown whole, so sub-KB values must round rather than truncate. */
test('formatKB: rounds at the requested width', () => {
  assert.equal(formatKB(1500, 0), '1');
  assert.equal(formatKB(100), '0.1');
});

/** No unit suffix: callers compose their own separators and labels. */
test('formatKB: appends no unit suffix', () => {
  assert.equal(formatKB(4096), '4.0');
  assert.equal(formatKB(4096, 0), '4');
});
