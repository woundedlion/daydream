/*
 * Drives the solids tool's op-chain reorder in headless Chrome, over the same
 * manifest server scripts/browser-smoke.mjs uses.
 *
 *   node scripts/solids-probe.mjs
 *
 * The unit suite runs over tests/fake_dom.js, which models neither layout nor
 * pointer capture, so it cannot tell a grip that reorders from one that reorders
 * only under a mouse: the row geometry the drop slot is read from, the capture
 * the gesture rides on, and the touch-action that decides whether a finger drags
 * the row or scrolls the list all exist only in a browser. This job drags a row
 * with a real mouse and again with a real finger, and requires a press that never
 * travels to leave the chain — and the row — exactly as it found them.
 */
import { centre, checks, dragBetween, isMain, runProbe } from './probe_harness.mjs';

const PAGE = 'tools/solids.html';
// Tall enough that a three-op chain lays out without the list scrolling, so the
// drop slot the drag names is the one the pointer is over.
const VIEWPORT = { width: 1280, height: 900, hasTouch: true };
const TIMEOUT_MS = 90_000;
// Three ops that read differently in the row labels, so a reorder is legible.
const OPS = ['kis', 'ambo', 'dual'];
const GRIP = '.op-item .drag-handle';
const DRAG_STEPS = 12;
// How long the base-solid footer must stop growing before its layout is taken as
// settled.
const SETTLE_MS = 1_000;

/**
 * The op names the chain shows, in order.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<string[]>} One entry per row, e.g. 'KIS'.
 */
const chainNames = (tab) => tab.$$eval('#opsList .op-item .font-bold',
  (nodes) => nodes.map((node) => (node.textContent ?? '').replace(/^\d+\.\s*/, '')));

/**
 * Adds one op through its grid button, waiting for the gate to enable it and for
 * the row to land.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {string} op - The op's data-op name.
 * @param {number} rows - Rows the chain must hold once the op is in.
 * @returns {Promise<void>}
 */
async function addOp(tab, op, rows) {
  await tab.waitForSelector(`#addOpGrid [data-op="${op}"]:not([disabled])`);
  await tab.click(`#addOpGrid [data-op="${op}"]`);
  await tab.waitForFunction(
    (count) => document.querySelectorAll('#opsList .op-item').length === count, {}, rows);
}

/**
 * Waits for the chain to read as `expected`, and reports what it holds either
 * way. A reorder commits behind an async validation, so the order is polled
 * rather than sampled.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {string[]} expected - The op names the chain should show.
 * @returns {Promise<string[]>} The names the chain settled on.
 */
async function settledNames(tab, expected) {
  try {
    await tab.waitForFunction(
      (want) => [...document.querySelectorAll('#opsList .op-item .font-bold')]
        .map((node) => (node.textContent ?? '').replace(/^\d+\.\s*/, '')).join() === want,
      { timeout: 5_000 }, expected.join());
  } catch { /* a mismatch is the failure; the caller reports what it settled on. */ }
  return chainNames(tab);
}

/**
 * Presses the row's grip and walks the pointer down the list before releasing.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @param {{x: number, y: number}} from - Where the gesture starts.
 * @param {number} y - Where it ends.
 * @param {boolean} touch - Drive the touchscreen rather than the mouse.
 * @returns {Promise<void>}
 */
const dragTo = (tab, from, y, touch) =>
  dragBetween(tab, from, { x: from.x, y }, { steps: DRAG_STEPS, touch });

/** @param {import('puppeteer-core').Page} tab */
export async function probeChain(tab) {
  const { failures, check } = checks();

  const motion = await tab.$eval('#toggleRotate', (node) => ({
    checked: node.getAttribute('aria-checked'),
    transition: getComputedStyle(node).transitionDuration,
  }));
  check(motion.checked === 'false', 'reduced motion starts auto-rotation off');
  check(motion.transition === '0s', 'reduced motion removes control transitions');
  await tab.click('#toggleRotate');
  check(await tab.$eval('#toggleRotate', (node) => node.getAttribute('aria-checked')) === 'true',
    'the rotation switch can explicitly start motion');

  for (const [i, op] of OPS.entries()) await addOp(tab, op, i + 1);
  const built = await chainNames(tab);
  check(built.join() === OPS.map((op) => op.toUpperCase()).join(),
    `the chain builds as ${built.join(', ')}`);
  if (built.length !== OPS.length) return failures;

  // The property that decides whether a finger drags the row or scrolls the
  // list out from under it. It has no fake-DOM equivalent.
  const touchAction = await tab.$eval(GRIP,
    (node) => getComputedStyle(node).touchAction);
  check(touchAction === 'none', `the grip claims the touch gesture (${touchAction})`);

  // Nothing in the chain is ever armed draggable, so a native drag can neither
  // start on a row nor be left armed on one.
  const armed = () => tab.$$eval('#opsList *',
    (nodes) => nodes.filter((node) => node.draggable).length);
  check(await armed() === 0, 'no row is armed for a native drag');

  const grips = await tab.$$(GRIP);
  const rows = await Promise.all(
    (await tab.$$('#opsList .op-item')).map((row) => row.boundingBox()));
  if (rows.some((row) => row === null)) throw new Error('an op row has no layout box');
  const below = rows[2].y + rows[2].height - 4;

  // A press the pointer never walks away from is not a reorder, and must leave
  // the chain, the row's arming and its drag styling exactly as it found them.
  const first = centre(await grips[0].boundingBox());
  await tab.mouse.click(first.x, first.y);
  check((await chainNames(tab)).join() === built.join(),
    'a press on the grip that never travels reorders nothing');
  check(await armed() === 0, 'a press on the grip leaves no row armed');
  check(await tab.$('#opsList .op-item.dragging') === null,
    'a press on the grip leaves no row stuck mid-drag');

  const mouseWant = [built[1], built[2], built[0]];
  await dragTo(tab, first, below, false);
  const afterMouse = await settledNames(tab, mouseWant);
  check(afterMouse.join() === mouseWant.join(),
    `a mouse drag moves the op it grips (${afterMouse.join(', ')})`);
  check(await tab.$('#opsList .op-item.dragging') === null,
    'the release clears the drag styling');
  if (afterMouse.join() !== mouseWant.join()) return failures;

  // The same reorder from a finger. HTML5 drag-and-drop never starts from one,
  // so only a real touch gesture answers whether the grip works on a phone.
  const touchGrips = await tab.$$(GRIP);
  const touchFrom = centre(await touchGrips[0].boundingBox());
  const touchWant = [afterMouse[1], afterMouse[2], afterMouse[0]];
  await dragTo(tab, touchFrom, below, true);
  const afterTouch = await settledNames(tab, touchWant);
  check(afterTouch.join() === touchWant.join(),
    `a touch drag moves the op it grips (${afterTouch.join(', ')})`);

  return failures;
}

if (isMain(import.meta.url)) await runProbe({
  name: 'solids-probe',
  page: PAGE,
  timeoutMs: TIMEOUT_MS,
  success: 'the op chain reorders under both a mouse and a finger.',
  run: async ({ open }) => {
    const failures = [];
    const tab = await open({
      viewport: VIEWPORT,
      prepare: (page) => page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ]),
    });
    // The page declares no loading overlay. Its init titles the base card as its
    // last act, after the WASM module is up and the add-op grid's delegated click
    // listener is wired — a click landing before that reaches nothing.
    await tab.waitForFunction(
      () => (document.getElementById('baseTitle')?.textContent ?? '').length > 0);
    // Then the base-solid footer, which init deliberately fills one macrotask at a
    // time: while it runs it both reflows the page under a measured pointer and
    // starves the WASM validation every op add waits on.
    await tab.waitForFunction((settle) => {
      const count = document.querySelectorAll('.thumb-btn').length;
      const seen = (window.solidsProbeThumbs ??= { count: -1, since: 0 });
      if (count !== seen.count) {
        Object.assign(seen, { count, since: performance.now() });
        return false;
      }
      return count > 0 && performance.now() - seen.since > settle;
    }, { polling: 200 }, SETTLE_MS);
    failures.push(...await probeChain(tab));
    return failures;
  },
});
