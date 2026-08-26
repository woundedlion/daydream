/*
 * Drives the palette tool's strip zoom and hue-key wheel in headless Chrome,
 * over the same manifest server scripts/browser-smoke.mjs uses.
 *
 *   node scripts/palettes-probe.mjs
 *
 * Both gestures read the pointer through getBoundingClientRect and ride on
 * pointer capture, neither of which tests/fake_dom.js has: its rects are zero,
 * so every strip position collapses onto 0 and every wheel hit test misses, and
 * a drag that leaves the element stops arriving. This job drags the strip with a
 * real mouse and requires the phase window it swept, walks the pointer out of
 * the strip's vertical bounds and requires the zoom to be abandoned, and drags a
 * wheel marker and requires the key it gripped to take the hue under the
 * pointer.
 */
import { centre, checks, dragBetween, paddingBoxOf, runProbe } from './probe_harness.mjs';

const PAGE = 'tools/palettes.html';
const VIEWPORT = { width: 1280, height: 900 };
const TIMEOUT_MS = 90_000;
const STRIP = '#colorStripCanvas';
const HEADING = '#palette_range_heading';
const RESET = '#resetZoomButton';
const WHEEL = '#hueKeyWheelCanvas';
const HANDLES = '#hueKeyWheelGroup [role="slider"]:not([hidden])';
const DRAG_STEPS = 12;
// Strip positions the mouse drag names, far enough apart to clear the tool's
// drag threshold so the release reads as a zoom rather than a copy.
const ZOOM_FROM = 0.25;
const ZOOM_TO = 0.75;
// Widest a zoom endpoint may miss the position dragged to, as a strip fraction.
const POSITION_TOLERANCE = 0.01;
// Widest a dragged hue key may miss the hue under the pointer, in degrees: the
// handle publishes whole degrees and the marker angle is derived back from one.
const HUE_TOLERANCE = 3;

/**
 * The phase window the strip heading reports.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<{start: number, end: number}>} The window the heading names.
 */
async function headingRange(tab) {
  const text = await tab.$eval(HEADING, (node) => node.textContent ?? '');
  const numbers = text.match(/-?\d*\.?\d+/g) ?? [];
  return { start: Number(numbers[0]), end: Number(numbers[1]) };
}

/**
 * Every drawn hue key's hue, as its off-screen slider handle publishes it.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<number[]>} One whole-degree hue per key, in key order.
 */
const hueDegrees = (tab) => tab.$$eval(HANDLES,
  (nodes) => nodes.map((node) => Number(node.getAttribute('aria-valuenow'))));

/**
 * The hue keys once the frame the gesture scheduled has drawn. The wheel
 * redraws on a frame scheduler, so a read taken straight off a release can
 * still hold the pre-gesture hues.
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<number[]>} One whole-degree hue per key, in key order.
 */
async function settledHueDegrees(tab) {
  await tab.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  return hueDegrees(tab);
}

/**
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<string[]>} One entry per failed check.
 */
async function probeColorStrip(tab) {
  const { failures, check } = checks();

  await tab.$eval(STRIP, (node) => node.scrollIntoView({ block: 'center' }));
  // The gradient fills the canvas' padding box, inside the border its bounding
  // rect carries, so the positions the page reports are fractions of that box.
  const box = await paddingBoxOf(tab, STRIP);
  check(box.width > 0 && box.height > 0,
    `the strip lays out ${Math.round(box.width)}x${Math.round(box.height)}`);

  const at = (position) => ({
    x: box.x + box.width * position, y: box.y + box.height / 2,
  });
  const opening = await headingRange(tab);
  check(opening.start === 0 && opening.end === 1,
    `the strip opens on the whole palette (${opening.start}, ${opening.end})`);
  check(await tab.$eval(RESET, (node) => node.classList.contains('hidden')),
    'the reset-zoom button is hidden while nothing is zoomed');

  let cursorPressed = '';
  await dragBetween(tab, at(ZOOM_FROM), at(ZOOM_TO), {
    steps: DRAG_STEPS,
    pressed: async () => {
      cursorPressed = await tab.$eval(STRIP, (node) => node.style.cursor);
    },
  });
  check(cursorPressed === 'crosshair',
    `the press opens a selection on the strip (cursor ${cursorPressed || 'unset'})`);

  const zoomed = await headingRange(tab);
  check(Math.abs(zoomed.start - ZOOM_FROM) < POSITION_TOLERANCE
      && Math.abs(zoomed.end - ZOOM_TO) < POSITION_TOLERANCE,
    `the drag zooms onto the window it swept (${zoomed.start}, ${zoomed.end})`);
  const label = await tab.$eval(STRIP, (node) => node.getAttribute('aria-label') ?? '');
  check(label.includes(zoomed.start.toFixed(3)),
    'the strip republishes the zoomed window as its accessible name');
  check(!await tab.$eval(RESET, (node) => node.classList.contains('hidden')),
    'the zoom reveals the reset-zoom button');

  await tab.$eval(RESET, (node) => node.click());
  const reset = await headingRange(tab);
  check(reset.start === 0 && reset.end === 1,
    `resetting the zoom restores the whole palette (${reset.start}, ${reset.end})`);

  // The palette's own first column: a pointer scaled by the bordered rect stops
  // a border width short of it and phase 0 is unreachable.
  await dragBetween(tab, at(0), at(0.5), { steps: DRAG_STEPS });
  const fromEdge = await headingRange(tab);
  check(fromEdge.start === 0,
    `a drag from the strip's leading edge reaches phase 0 (${fromEdge.start})`);
  await tab.$eval(RESET, (node) => node.click());

  // The bound only a real layout carries: a pointer that leaves the strip
  // vertically abandons the selection, and the capture keeps delivering the
  // moves that say so.
  await dragBetween(tab, at(ZOOM_FROM),
    { x: at(ZOOM_TO).x, y: box.y - box.height }, { steps: DRAG_STEPS });
  const escaped = await headingRange(tab);
  check(escaped.start === 0 && escaped.end === 1,
    `a drag released above the strip zooms nothing (${escaped.start}, ${escaped.end})`);
  check(await tab.$eval(STRIP, (node) => node.style.cursor) === 'pointer',
    'the abandoned drag restores the strip cursor');

  return failures;
}

/**
 * @param {import('puppeteer-core').Page} tab - The page.
 * @returns {Promise<string[]>} One entry per failed check.
 */
async function probeHueWheel(tab) {
  const { failures, check } = checks();

  await tab.click('#tab-btn-generative');
  await tab.waitForSelector(WHEEL, { visible: true });
  await tab.$eval('#gen_hue_mode', (node) => {
    node.value = 'CUSTOM';
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await tab.waitForFunction(
    (selector) => document.querySelectorAll(selector).length >= 2, {}, HANDLES);

  const opening = await settledHueDegrees(tab);
  check(opening.length >= 2, `the wheel publishes ${opening.length} hue keys`);

  await tab.$eval(WHEEL, (node) => node.scrollIntoView({ block: 'center' }));
  // The wheel is drawn in its padding box too, so a marker's canvas point maps
  // back through that box rather than the bordered one.
  const box = await paddingBoxOf(tab, WHEEL);

  // Grip where the page drew, by asking the wheel's own marker geometry rather
  // than a copy of the formula.
  const viewportPointOf = async (degrees) => {
    const point = await tab.evaluate(async (hue) => {
      const { hueKeyMarkerPoints } = await import('./palette_wheel.js');
      const canvas = document.getElementById('hueKeyWheelCanvas');
      const [marker] = hueKeyMarkerPoints(
        { baseTurns: hue / 360, offsets: [0] }, canvas.width, canvas.height);
      return { ...marker, width: canvas.width, height: canvas.height };
    }, degrees);
    return {
      x: box.x + (point.x * box.width) / point.width,
      y: box.y + (point.y * box.height) / point.height,
    };
  };

  const grip = await viewportPointOf(opening[0]);
  await tab.mouse.move(grip.x, grip.y);
  check(await tab.$eval(WHEEL, (node) => node.style.cursor) === 'grab',
    'hovering a marker offers the grab cursor');

  const target = (opening[0] + 90) % 360;
  await dragBetween(tab, grip, await viewportPointOf(target), { steps: DRAG_STEPS });
  const moved = await settledHueDegrees(tab);
  const missed = Math.abs(((moved[0] - target + 540) % 360) - 180);
  check(missed < HUE_TOLERANCE,
    `the dragged key takes the hue under the pointer (${moved[0]} for ${target})`);
  check(moved.slice(1).join() === opening.slice(1).join(),
    `the drag moves only the key it gripped (${moved.join(', ')})`);
  check(await tab.$eval(WHEEL, (node) => node.style.cursor) === 'default',
    'the release drops the grab cursor');

  // A press away from every marker is not a grab: the hit test declines the
  // drag, so the walk that follows moves nothing.
  await dragBetween(tab, centre(box), await viewportPointOf((target + 120) % 360),
    { steps: DRAG_STEPS });
  const idle = await settledHueDegrees(tab);
  check(idle.join() === moved.join(),
    `a drag that starts off every marker moves no key (${idle.join(', ')})`);

  return failures;
}

await runProbe({
  name: 'palettes-probe',
  page: PAGE,
  timeoutMs: TIMEOUT_MS,
  success: 'the strip zooms and the hue keys drag under a real pointer.',
  run: async ({ open }) => {
    const failures = [];
    const tab = await open({ viewport: VIEWPORT });
    // The engine fills the effect-recipe list as the last act of startup; the
    // markup ships it holding nothing but its placeholder option.
    await tab.waitForFunction(
      () => (document.getElementById('effect_recipe_preset')?.children.length ?? 0) > 1);
    failures.push(...await probeColorStrip(tab));
    failures.push(...await probeHueWheel(tab));
    return failures;
  },
});
