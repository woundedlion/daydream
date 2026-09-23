/*
 * Exercises the shader workbench's pipeline controls in headless Chrome over
 * the same manifest server scripts/browser-smoke.mjs uses.
 *
 *   node scripts/workbench-probe.mjs
 */
import { boxOf, centre, checks, isMain, runProbe } from './probe_harness.mjs';

const PAGE = 'tools/shader.html';
const VIEWPORT = { width: 1674, height: 543 };
// Shorter than the anchored palette, so its vertical clamp has to engage.
const SHORT_HEIGHT = 170;
const TIMEOUT_MS = 90_000;
const SLIDER_FRACTION = 0.75;
// A fraction of a domain that lands on no round step grid.
const OFF_GRID_FRACTION = 0.3170159;
const VALUE_TOLERANCE = 1e-4;

/**
 * @param {{x: number, y: number, width: number, height: number}} a
 * @param {{x: number, y: number, width: number, height: number}} b
 */
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;

/** @param {import('puppeteer-core').Page} tab @param {string} carrier */
const bandChipNames = (tab, carrier) => tab.$$eval(
  `.chain-band[data-carrier="${carrier}"] .chain-chip-name`,
  (nodes) => nodes.map((node) => node.textContent ?? ''));

/** @param {import('puppeteer-core').Page} tab */
async function savedDocument(tab) {
  await tab.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    Object.assign(window, { exported: [] });
    URL.createObjectURL = (blob) => {
      window.exported.push(blob.text());
      return create(blob);
    };
  });
  await (await tab.waitForSelector('#shader-document-save')).click();
  await tab.waitForFunction(() => window.exported.length > 0);
  const source = await tab.evaluate(async () => (await Promise.all(window.exported)).at(-1));
  if (typeof source !== 'string') throw new Error('Save exported no document');
  return JSON.parse(source);
}

/** @param {import('puppeteer-core').Page} tab */
export async function probeStrip(tab) {
  const { failures, check } = checks();

  check(await tab.$('#gui-container > .effect-gui') === null,
    'the local effect panel is absent');
  check(await tab.$('#gui-container > .global-gui') !== null,
    'global controls remain mounted');
  // The strip is the only chain region the page mounts: no stage library
  // panel and no drag-and-drop insertion.
  const regions = await tab.$$eval('.main-area > *',
    (nodes) => nodes.map((node) => node.id).join());
  const draggable = await tab.$('#chain-strip [draggable="true"]');
  check(regions === 'chain-strip,stats-bar,canvas-container,gui-container'
      && draggable === null,
  `the main area mounts ${regions} beside no stage library or draggable chip`);

  const initialStages = await tab.$$eval('.chain-chip[aria-expanded]', (nodes) => nodes.map(
    (node) => ({ expanded: node.getAttribute('aria-expanded'),
      controls: getComputedStyle(node.querySelector('.chain-chip-params')).display,
      controlsHeight: node.querySelector('.chain-chip-params').getBoundingClientRect().height,
      controlsVisibility: getComputedStyle(
        node.querySelector('.chain-chip-params')).visibility })));
  check(initialStages.length > 0
      && initialStages.every((stage) => stage.expanded === 'false'
        && stage.controls === 'grid'
        && stage.controlsHeight === 0
        && stage.controlsVisibility === 'hidden'),
  `${initialStages.length} stage cards start as single collapsed header rows`);
  const closedHeaders = await tab.evaluate(() => {
    const rotate = document.querySelector('.chain-chip[data-label="rotate"]');
    const project = document.querySelector('.chain-chip[data-label="project"]');
    const projectHeader = project.querySelector('.chain-chip-header');
    const functionLabel = project.querySelector('.chain-chip-function-label');
    return {
      icons: [...rotate.querySelectorAll('.chain-chip-header button')]
        .map((button) => button.textContent),
      rotateChildren: [...rotate.querySelector('.chain-chip-header').children]
        .map((child) => child.className),
      projectChildren: [...projectHeader.children].map((child) => child.className),
      projectPrefix: functionLabel.firstChild.textContent,
      projectSelector: getComputedStyle(functionLabel).display,
    };
  });
  check(closedHeaders.icons.join('') === '◉←→×'
      && closedHeaders.rotateChildren.join(' ') === 'chain-chip-name '
        + 'chain-chip-bypass chain-chip-move chain-chip-move chain-chip-remove'
      && closedHeaders.projectChildren.join('') === 'chain-chip-function-label'
      && closedHeaders.projectPrefix === 'Projection: '
      && closedHeaders.projectSelector !== 'none',
  'closed domain and transition cards omit instance ids');
  const closedGeometry = await tab.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    };
    const band = document.querySelector('.chain-band[data-carrier="sphere"]');
    return {
      domain: box('.chain-chip[data-label="rotate"]'),
      transition: box('.chain-chip[data-label="project"]'),
      frameTop: Number.parseFloat(getComputedStyle(band, '::before').top),
    };
  });
  check(Math.abs(closedGeometry.transition.top - closedGeometry.domain.top) < 1
      && Math.abs(closedGeometry.transition.height - closedGeometry.domain.height) < 1,
  `closed domain/transition cards align at ${Math.round(closedGeometry.domain.top)}`
    + `/${Math.round(closedGeometry.transition.top)}px and stand `
    + `${Math.round(closedGeometry.domain.height)}`
    + `/${Math.round(closedGeometry.transition.height)}px tall`);
  check(closedGeometry.frameTop >= 0,
    'domain frames begin inside the vertical clipping boundary');
  check(await tab.$('.chain-band[data-carrier="color"]') === null,
    'the terminal color carrier renders no band');

  const hoverHeader = '.chain-chip[data-label="project"] .chain-chip-header';
  const closedCard = await boxOf(tab, '.chain-chip[data-label="project"]');
  const closedHeader = await boxOf(tab, hoverHeader);
  const closedBackground = await tab.$eval('.chain-chip[data-label="project"]',
    (node) => getComputedStyle(node).backgroundColor);
  await (await tab.waitForSelector(hoverHeader)).hover();
  await tab.waitForFunction(() => document.querySelector(
    '.chain-chip[data-label="project"]')?.getAttribute('aria-expanded') === 'true');
  const hoverCard = await boxOf(tab, '.chain-chip[data-label="project"]');
  const openHeader = await boxOf(tab, hoverHeader);
  check(Math.abs(hoverCard.width - closedCard.width) < 1
      && Math.abs(openHeader.width - closedHeader.width) < 1
      && Math.abs(openHeader.height - closedHeader.height) < 1,
  `the header stays ${Math.round(openHeader.width)}×${Math.round(openHeader.height)}px when open`);
  check(await tab.$eval('.chain-chip[data-label="project"]', (node) =>
    node.querySelector('.chain-chip-name') === null
      && getComputedStyle(node.querySelector('.chain-chip-function-label')).display !== 'none'),
  'an open transition card keeps the same selector-only header');
  await tab.mouse.move(0, 0);
  await tab.waitForFunction(() => document.querySelector(
    '.chain-chip[data-label="project"]')?.getAttribute('aria-expanded') === 'false');
  check(await tab.$eval('.chain-chip[data-label="project"]',
    (node) => node.getAttribute('aria-expanded') === 'false'),
  'mouse leave closes a transient stage card');

  // The pointer is parked off the strip, so only the keyboard can be opening
  // the card here.
  await tab.$eval('.chain-chip[data-label="rotate"]', (node) => node.focus());
  const focusOpened = await tab.$eval('.chain-chip[data-label="rotate"]', (node) => ({
    expanded: node.getAttribute('aria-expanded'),
    controlsHeight: node.querySelector('.chain-chip-params').getBoundingClientRect().height,
    controlsVisibility: getComputedStyle(node.querySelector('.chain-chip-params')).visibility,
  }));
  check(focusOpened.expanded === 'true' && focusOpened.controlsHeight > 0
      && focusOpened.controlsVisibility === 'visible',
  `keyboard focus discloses ${Math.round(focusOpened.controlsHeight)}px of controls`);
  await tab.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  check(await tab.$eval('.chain-chip[data-label="rotate"]',
    (node) => node.getAttribute('aria-expanded') === 'false'),
  'losing focus closes the card again');

  await tab.mouse.click(closedCard.x + 2, closedCard.y + closedCard.height / 2);
  await tab.mouse.move(0, 0);
  check(await tab.$eval('.chain-chip[data-label="project"]',
    (node) => node.getAttribute('aria-expanded') === 'true'),
  'click pins a stage card open after mouse leave');
  const pinnedCard = await boxOf(tab, '.chain-chip[data-label="project"]');
  check(await tab.$eval('.chain-chip[data-label="project"]',
    (node, expected) => getComputedStyle(node).backgroundColor === expected,
    closedBackground),
  `a pinned stage keeps its opaque ${closedBackground} panel`);
  await tab.mouse.click(pinnedCard.x + 2, pinnedCard.y + pinnedCard.height / 2);
  check(await tab.$eval('.chain-chip[data-label="project"]',
    (node) => node.getAttribute('aria-expanded') === 'false'),
  'clicking a pinned stage header closes it');

  await tab.mouse.click(closedCard.x + 2, closedCard.y + closedCard.height / 2);
  const elsewhereLabel = (await tab.$$eval('.chain-chip', (nodes) => nodes.map(
    (node) => (node instanceof HTMLElement ? node.dataset.label ?? '' : ''))))
    .find((label) => label !== '' && label !== 'project');
  const travelled = await boxOf(tab,
    `.chain-chip[data-label="${elsewhereLabel}"] .chain-chip-header`);
  await tab.mouse.move(travelled.x + 2, centre(travelled).y);
  await tab.mouse.down();
  await tab.mouse.move(0, 0, { steps: 8 });
  await tab.mouse.up();
  check((await tab.$$eval('.chain-chip[aria-current="true"]', (nodes) => nodes.map(
    (node) => (node instanceof HTMLElement ? node.dataset.label ?? '' : ''))))
    .join() === 'project',
  `a press that travels off ${elsewhereLabel} leaves the selection alone`);
  await tab.mouse.click(closedCard.x + 2, closedCard.y + closedCard.height / 2);
  await tab.mouse.move(0, 0);

  const collapsedDomain = await tab.$eval('.chain-band[data-carrier="sphere"]', (node) => ({
    band: node.getBoundingClientRect().height,
    frame: Number.parseFloat(getComputedStyle(node, '::before').height),
  }));
  await (await tab.waitForSelector(
    '.chain-chip[data-label="rotate"] .chain-chip-header')).hover();
  await tab.waitForFunction(() => document.querySelector(
    '.chain-chip[data-label="rotate"]')?.getAttribute('aria-expanded') === 'true');
  const openDomain = await tab.$eval('.chain-band[data-carrier="sphere"]', (node) => ({
    band: node.getBoundingClientRect().height,
    frame: Number.parseFloat(getComputedStyle(node, '::before').height),
  }));
  check(openDomain.band > collapsedDomain.band
      && Math.abs(openDomain.frame - collapsedDomain.frame) < 1,
  `an open stage leaves the domain frame at ${Math.round(openDomain.frame)}px`);
  await tab.mouse.move(0, 0);

  const layout = await tab.evaluate(() => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top,
        bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const chipBoxes = [...document.querySelectorAll('.chain-chip')].map(box);
    const bandChips = [...document.querySelectorAll('.chain-band > .chain-chip--stage')];
    const sockets = document.querySelectorAll('.chain-strip > .chain-chip--socket');
    const contained = bandChips.length > 0
      && bandChips.length + sockets.length === chipBoxes.length
      && bandChips.every((chip) => {
        const child = chip.getBoundingClientRect();
        const parent = chip.parentElement.getBoundingClientRect();
        return child.left >= parent.left && child.right <= parent.right;
      });
    const separate = chipBoxes.every((chip, index) => chipBoxes.slice(index + 1)
      .every((other) => chip.right <= other.left || other.right <= chip.left
        || chip.bottom <= other.top || other.bottom <= chip.top));
    return {
      chipBoxes,
      contained,
      separate,
      strip: box(document.getElementById('chain-strip')),
      main: box(document.querySelector('.main-area')),
      stripOpacity: getComputedStyle(document.getElementById('chain-strip')).opacity,
      stripPosition: getComputedStyle(document.getElementById('chain-strip')).position,
    };
  });
  check(layout.contained && layout.separate,
    'stage cards stay inside their bands without overlapping');
  check(layout.chipBoxes.every((box) => box.width <= 560),
    'collapsed stage headers remain bounded while reserving their open width');
  check(layout.stripPosition === 'absolute'
      && Math.abs(layout.strip.top - layout.main.top) < 1
      && Number(layout.stripOpacity) === 0.9,
  'the pipeline overlays the preview at 90% opacity');
  check(layout.main.height > VIEWPORT.height * 0.8,
    `the preview retains ${Math.round(layout.main.height)}px beneath the pipeline`);

  const scrollHits = await tab.$$eval('.chain-scroll-button', (nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(
      rect.x + rect.width / 2, rect.y + rect.height / 2));
  }));
  check(scrollHits.length === 2 && scrollHits.every((reached) => reached),
    'the floating panels leave both scroll buttons on top');

  // A `<input type=range>` re-snaps its value onto its step grid, and a fake DOM
  // does not: only a real browser shows whether an authored value survives being
  // written to the control it is edited through.
  const held = await tab.$$eval('.chain-param-control[type="range"]', (nodes, fraction) => nodes
    .filter((node) => node instanceof HTMLInputElement)
    .map((node) => {
      const minimum = Number(node.min);
      const probe = minimum + (Number(node.max) - minimum) * fraction;
      const authored = node.value;
      node.value = String(probe);
      const kept = Math.abs(Number(node.value) - probe) <= Math.abs(probe) * 1e-6;
      node.value = authored;
      const row = node.closest('.chain-param');
      return { kept, parameter: row instanceof HTMLElement ? row.dataset.parameter ?? '' : '' };
    }), OFF_GRID_FRACTION);
  const snapped = held.filter((entry) => !entry.kept).map((entry) => entry.parameter);
  check(held.length > 0 && snapped.length === 0,
    `${held.length} inline sliders hold an off-grid value unsnapped`
      + (snapped.length > 0 ? ` (${snapped.join(', ')} re-snapped)` : ''));

  // Constraint validation is the browser's, so only a real browser reports
  // whether the readouts are showing values their own control calls invalid.
  const readouts = await tab.$$eval('.chain-param-value', (nodes) => nodes
    .filter((node) => node instanceof HTMLInputElement)
    .map((node) => {
      const row = node.closest('.chain-param');
      return { valid: node.validity.valid, mismatch: node.validity.stepMismatch,
        parameter: row instanceof HTMLElement ? row.dataset.parameter ?? '' : '' };
    }));
  const invalid = readouts.filter((entry) => !entry.valid).map((entry) => entry.parameter);
  check(readouts.length > 0 && invalid.length === 0,
    `${readouts.length} inline readouts report their stored value valid`
      + (invalid.length > 0 ? ` (${invalid.join(', ')} do not)` : ''));

  const add = '.chain-band[data-carrier="plane"] .chain-band-add';
  await (await tab.waitForSelector(add)).click();
  await tab.waitForSelector('.chain-palette-entry');
  const choices = await tab.$$eval('.chain-palette-entry', (nodes) => nodes.map((node) => ({
    operator: node instanceof HTMLElement ? node.dataset.operator ?? '' : '',
    disabled: node.getAttribute('aria-disabled'),
  })));
  check(choices.length > 0 && choices.every((choice) => choice.disabled === null),
    `the + menu contains ${choices.length} valid choices and no disabled rows`);
  check(!choices.some((choice) => choice.operator === 'sphere.rotate.v2'),
    'the plane + menu omits an invalid sphere stage');
  await (await tab.waitForSelector(
    '.chain-palette-entry[data-operator="warp.wave-shear.v2"]')).click();
  await tab.waitForFunction(() => [...document.querySelectorAll('.chain-chip-name')]
    .some((node) => node.textContent === 'Wave Shear'));
  check((await bandChipNames(tab, 'plane')).includes('Wave Shear'),
    'the + menu inserts its selected stage');
  const planeChips = await tab.$$eval('.chain-band[data-carrier="plane"] .chain-chip',
    (nodes) => nodes.map((node) => ({
      name: node.querySelector('.chain-chip-name')?.textContent ?? '',
      current: node.getAttribute('aria-current'),
      expanded: node.getAttribute('aria-expanded'),
    })));
  const landed = planeChips.find((chip) => chip.name === 'Wave Shear');
  check(landed?.current === 'true' && landed?.expanded === 'true',
    'the inserted stage is selected with its controls open');

  // A palette that survives a press elsewhere outlives the chain it was opened
  // over; the fake DOM models neither the press nor the focus move.
  await (await tab.waitForSelector(add)).click();
  await tab.waitForSelector('.chain-palette-entry');
  check(await tab.$eval('.chain-palette .chain-palette-entry',
    (node) => node.getAttribute('aria-selected')) === 'true',
  'the opened palette marks its focused option selected');

  // A computed backgroundColor spells its alpha only when that alpha is below
  // one, so an rgb() is exactly a surface nothing reads through.
  const entryBox = await boxOf(tab, '.chain-palette .chain-palette-entry');
  const painted = async () => tab.evaluate(() => {
    const paint = (selector) => {
      const node = document.querySelector(selector);
      return node === null ? 'absent' : getComputedStyle(node).backgroundColor;
    };
    return {
      card: paint('.chain-chip--socket'),
      palette: paint('.chain-palette'),
      entry: paint('.chain-palette .chain-palette-entry'),
    };
  });
  const resting = await painted();
  await tab.mouse.move(centre(entryBox).x, centre(entryBox).y);
  const hovered = await painted();
  const surfaces = Object.entries({
    'transition card': resting.card,
    palette: resting.palette,
    'palette row': resting.entry,
    'hovered palette row': hovered.entry,
  });
  check(surfaces.every(([, color]) => color.startsWith('rgb(')),
    `the transition card and its palette paint opaque (${
      surfaces.map(([what, color]) => `${what} ${color}`).join(', ')})`);
  check(hovered.entry !== resting.entry,
    `hover raises the palette row from ${resting.entry} to ${hovered.entry}`);
  const anchorBox = await boxOf(tab, add);
  const paletteBox = await boxOf(tab, '.chain-palette');
  const palettePosition = await tab.$eval('.chain-palette',
    (node) => getComputedStyle(node).position);
  const expectedPaletteLeft = Math.max(8,
    Math.min(anchorBox.x, VIEWPORT.width - paletteBox.width - 8));
  check(palettePosition === 'fixed'
      && Math.abs(paletteBox.x - expectedPaletteLeft) < 1
      && paletteBox.y >= anchorBox.y + anchorBox.height
      && paletteBox.y - anchorBox.y - anchorBox.height <= 8,
  `the palette opens under its anchor at ${Math.round(paletteBox.x)},`
    + `${Math.round(paletteBox.y)}px`);
  const elsewhere = await boxOf(tab,
    '.chain-band[data-carrier="sphere"] .chain-band-title');
  check(!overlaps(await boxOf(tab, '.chain-palette'), elsewhere),
    'the dismissal target sits clear of the open palette');
  await tab.mouse.click(centre(elsewhere).x, centre(elsewhere).y);
  check(await tab.$('.chain-palette') === null,
    'a press outside the palette dismisses it');

  const source = '.chain-chip-replace[aria-label="Source function"]';
  const sourceChoices = await tab.$eval(source, (node) => ({
    label: node.getAttribute('aria-label'),
    values: node instanceof HTMLSelectElement
      ? [...node.options].map((option) => option.value) : [],
  }));
  check(sourceChoices.label === 'Source function'
      && sourceChoices.values.every((value) => value.startsWith('sample.')),
  `the Source function selector offers ${sourceChoices.values.length} sampling stages`);
  await tab.select(source, 'sample.rings.v2');
  check(await tab.$eval(source, (node) => node instanceof HTMLSelectElement
    && node.value === 'sample.rings.v2'),
  'the source function changes directly from its selector');

  const sphereBandBefore = await boxOf(tab, '.chain-band[data-carrier="sphere"]');
  await (await tab.waitForSelector(
    '.chain-band[data-carrier="sphere"] .chain-band-add')).click();
  await (await tab.waitForSelector(
    '.chain-palette-entry[data-operator="sphere.lens.twist.v2"]')).click();
  await tab.waitForFunction(() => document.querySelectorAll(
    '.chain-band[data-carrier="sphere"] .chain-chip').length === 2);
  const sphereBandAfter = await boxOf(tab, '.chain-band[data-carrier="sphere"]');
  check(sphereBandAfter.width > sphereBandBefore.width,
    `adding a stage widens its domain (${Math.round(sphereBandBefore.width)}px → ${Math.round(sphereBandAfter.width)}px)`);
  const sphereBefore = await bandChipNames(tab, 'sphere');
  const moveLater = '.chain-band[data-carrier="sphere"]'
    + ' .chain-chip-move[aria-label$="later"]:not(:disabled)';
  await (await tab.waitForSelector(moveLater)).click();
  await tab.waitForFunction((previous) => [...document.querySelectorAll(
    '.chain-band[data-carrier="sphere"] .chain-chip-name')].map((node) => node.textContent).join()
      !== previous, {}, sphereBefore.join());
  const sphereAfter = await bandChipNames(tab, 'sphere');
  check(sphereAfter.join() === [...sphereBefore].reverse().join(),
    `reorder buttons move stages (${sphereAfter.join(', ')})`);

  // Reorder is button-driven only; a real press dragged over a second stage in
  // the same band is how a drop target would show itself.
  const sphereLabels = await tab.$$eval('.chain-band[data-carrier="sphere"] .chain-chip',
    (nodes) => nodes.map((node) => (node instanceof HTMLElement ? node.dataset.label ?? '' : '')));
  const dragged = await boxOf(tab,
    `.chain-chip[data-label="${sphereLabels[0]}"] .chain-chip-header`);
  await tab.mouse.move(centre(dragged).x, centre(dragged).y);
  await tab.mouse.down();
  const onto = await boxOf(tab,
    `.chain-chip[data-label="${sphereLabels.at(-1)}"] .chain-chip-header`);
  await tab.mouse.move(centre(onto).x, centre(onto).y, { steps: 8 });
  await tab.mouse.up();
  await tab.mouse.move(0, 0);
  check(sphereLabels.length > 1 && (await bandChipNames(tab, 'sphere')).join()
      === sphereAfter.join(),
  `dragging ${sphereLabels[0]} over ${sphereLabels.at(-1)} finds no drop target`);

  const track = '.chain-chip[data-label="rotate"]'
    + ' .chain-param[data-parameter="rotate.wander"] .chain-param-control';
  await (await tab.waitForSelector(
    '.chain-chip[data-label="rotate"] .chain-chip-name')).click();
  const slider = await boxOf(tab, track);
  await tab.mouse.click(slider.x + slider.width * SLIDER_FRACTION, centre(slider).y);
  const shown = Number(await tab.$eval(track, (node) => node.value));
  const stored = (await savedDocument(tab)).preset_bank.presets[0].values['rotate.wander'];
  check(Math.abs(stored - shown) < VALUE_TOLERANCE,
    `an inline control saves its value (${stored})`);

  // The step grid the readout gives up to stay valid comes back as arrow keys.
  const readout = '.chain-chip[data-label="rotate"]'
    + ' .chain-param[data-parameter="rotate.wander"] .chain-param-value';
  const readBefore = await tab.$eval(readout, (node) => {
    node.focus();
    return Number(node.value);
  });
  await tab.keyboard.press('ArrowUp');
  const readAfter = await tab.$eval(readout, (node) => Number(node.value));
  check(readAfter > readBefore && readAfter - readBefore < 0.01,
    `an arrow key nudges the readout ${readBefore} to ${readAfter}`);

  const animation = await tab.$eval('#shader-animation-toggle', (node) => ({
    disabled: node instanceof HTMLButtonElement ? node.disabled : true,
    text: node.textContent ?? '',
  }));
  check(!animation.disabled && animation.text === 'Pause animation',
    `animation is running after preset/control writes (${animation.text})`);

  const panels = await boxOf(tab, '#gui-container');
  for (const region of ['#shader-toolbar']) {
    const box = await boxOf(tab, region);
    check(!overlaps(panels, box), `global controls clear ${region}`);
  }

  await tab.setViewport({ width: 700, height: VIEWPORT.height });
  await tab.waitForFunction(() => window.innerWidth === 700);
  await (await tab.waitForSelector(add)).click();
  await tab.waitForSelector('.chain-palette-entry');
  const narrowAnchor = await boxOf(tab, add);
  const narrowPalette = await boxOf(tab, '.chain-palette');
  const narrowLeft = Math.max(8,
    Math.min(narrowAnchor.x, 700 - narrowPalette.width - 8));
  check(Math.abs(narrowPalette.x - narrowLeft) < 1
      && narrowPalette.y >= narrowAnchor.y + narrowAnchor.height
      && narrowPalette.x >= 8 && narrowPalette.x + narrowPalette.width <= 692,
  'the anchored palette stays inside a narrow viewport');
  await tab.keyboard.press('Escape');

  // Short enough that the palette cannot open below its anchor at all: the
  // vertical clamp has to lift it and cap its height, which the full-height
  // viewport above never asks for.
  await tab.setViewport({ width: VIEWPORT.width, height: SHORT_HEIGHT });
  await tab.waitForFunction((height) => window.innerHeight === height, {}, SHORT_HEIGHT);
  await (await tab.waitForSelector(add)).click();
  await tab.waitForSelector('.chain-palette-entry');
  const shortAnchor = await boxOf(tab, add);
  const shortPalette = await boxOf(tab, '.chain-palette');
  const capped = await tab.$eval('.chain-palette', (node) => ({
    overflow: getComputedStyle(node).overflowY,
    scrollable: node.scrollHeight > node.clientHeight,
  }));
  check(shortPalette.y + shortPalette.height <= SHORT_HEIGHT - 8 + 1
      && shortPalette.y >= 8
      && shortPalette.y < shortAnchor.y + shortAnchor.height,
  `the palette is lifted to ${Math.round(shortPalette.y)}px and ends `
    + `${Math.round(SHORT_HEIGHT - shortPalette.y - shortPalette.height)}px `
    + 'above a short viewport');
  check(capped.overflow === 'auto' && capped.scrollable,
    'the capped palette scrolls to its remaining entries');
  await tab.keyboard.press('Escape');

  // A source that reads the sphere directly collapses the plane crossing, so
  // that carrier holds no gap, chip or socket and is drawn no band at all.
  await (await tab.waitForSelector(
    '.chain-band[data-carrier="plane"] .chain-chip .chain-chip-remove')).click();
  await tab.waitForFunction(() => document.querySelector(
    '.chain-band[data-carrier="plane"] .chain-chip') === null);
  await tab.select(source, 'sample.spherical-rings.v3');
  await tab.waitForFunction(() => document.querySelector('.chain-band[data-carrier="plane"]') === null);
  const skipped = await tab.evaluate(() => ({
    source: document.querySelector('.chain-chip-replace[aria-label="Source function"]')?.value,
    carriers: [...document.querySelectorAll('.chain-band')].map(
      (band) => band.dataset.carrier),
  }));
  check(skipped.source === 'sample.spherical-rings.v3'
      && !skipped.carriers.includes('plane') && skipped.carriers.length > 0,
  'a carrier the chain passes over is drawn no band');
  return failures;
}

/**
 * Keyboard edits cross rebuilt DOM nodes while keeping the selected instance.
 * @param {import('puppeteer-core').Page} tab
 * @returns {Promise<string[]>} The failed checks.
 */
export async function probeStripHistory(tab) {
  const { failures, check } = checks();
  await tab.select('#shader-document-select', 'kaleidoscope-hex-bright');
  await tab.waitForSelector('.chain-chip[data-label="camera"]');
  await tab.waitForSelector('.chain-chip[data-label="lens"]');
  const labels = () => tab.$$eval('.chain-chip', nodes => nodes.map(node => node.dataset.label));
  const before = await labels();
  const first = before[0];
  const second = before[1];
  await tab.$eval('.chain-chip', node => node.focus());
  await tab.keyboard.down('Alt');
  await tab.keyboard.press('ArrowRight');
  await tab.keyboard.up('Alt');
  await tab.waitForFunction((label) => document.querySelector('.chain-chip')?.dataset.label === label, {}, second);
  const reordered = await labels();
  check(reordered[0] === second && reordered[1] === first,
    'Alt+Arrow commits a same-band reorder through the live DOM');
  check(await tab.evaluate(label => document.activeElement?.dataset.label === label, first),
    'reorder restores focus to the moved instance after rebuilding');

  await tab.keyboard.press('Delete');
  await tab.waitForFunction((label) => ![...document.querySelectorAll('.chain-chip')]
    .some((node) => node.dataset.label === label), {}, first);
  check(!(await labels()).includes(first), 'Delete removes the focused instance');
  check(await tab.evaluate(() => document.activeElement?.classList.contains('chain-chip')),
    'removal leaves focus on a surviving chip');
  await tab.keyboard.down('Control');
  await tab.keyboard.press('z');
  await tab.keyboard.up('Control');
  await tab.waitForFunction((wanted) => JSON.stringify([...document.querySelectorAll('.chain-chip')]
    .map((node) => node.dataset.label)) === wanted, {}, JSON.stringify(reordered));
  check(JSON.stringify(await labels()) === JSON.stringify(reordered),
    'the history shortcut bubbles from the replacement chip and restores the removed instance');
  await tab.keyboard.down('Control');
  await tab.keyboard.press('z');
  await tab.keyboard.up('Control');
  await tab.waitForFunction((wanted) => JSON.stringify([...document.querySelectorAll('.chain-chip')]
    .map((node) => node.dataset.label)) === wanted, {}, JSON.stringify(before));
  check(JSON.stringify(await labels()) === JSON.stringify(before),
    'a second undo restores the original order');
  check(await tab.$$eval('.chain-chip[tabindex="0"]', nodes => nodes.length === 1),
    'the rebuilt strip retains one roving tab stop');

  const crossing = '.chain-chip[data-label="project"]';
  await tab.$eval(crossing, node => node.focus());
  await tab.keyboard.press('Delete');
  await tab.waitForSelector('.chain-palette');
  check(await tab.evaluate(() => Boolean(document.activeElement?.closest('.chain-palette'))),
    'a crossing replacement palette receives keyboard focus');
  await tab.keyboard.press('Escape');
  check(await tab.$('.chain-palette') === null
    && await tab.evaluate(() => document.activeElement?.dataset.label === 'project'),
  'Escape removes the palette and restores its anchor focus');
  check(JSON.stringify(await labels()) === JSON.stringify(before),
    'dismissing a replacement palette leaves the chain intact');
  return failures;
}

// The promoted document that carries a value its compiled build holds as a
// constant, so the apply has to skip that id rather than refuse the preset.
const PARITY_EFFECT = 'ash-cloud';
const PARITY_TITLE = 'Ash Cloud';

/**
 * Loads a promoted document and swaps the preview onto its compiled build. The
 * swap re-applies every authored value through the effect's registered
 * controls, so one id no control takes refuses the whole preset and the status
 * reports the error instead of the side.
 * @param {import('puppeteer-core').Page} tab
 * @returns {Promise<string[]>} The failed checks.
 */
export async function probeParity(tab) {
  const { failures, check } = checks();

  await tab.select('#shader-document-select', PARITY_EFFECT);
  await tab.waitForFunction((title) => document
    .getElementById('shader-document-status')?.textContent?.startsWith(title),
  {}, PARITY_TITLE);
  const loaded = await tab.$eval('#shader-parity-toggle', (node) => ({
    armed: node instanceof HTMLButtonElement && !node.disabled,
    status: document.getElementById('shader-document-status')?.dataset.status,
  }));
  check(loaded.armed && loaded.status === 'ok',
    `the parity toggle arms on the loaded ${PARITY_EFFECT} document`);

  await (await tab.waitForSelector('#shader-parity-toggle')).click();
  await tab.waitForFunction(() => document.getElementById('shader-document-status')
    ?.textContent.endsWith('compiled build'));
  const applied = await tab.$eval('#shader-document-status', (node) => ({
    text: node.textContent ?? '',
    status: node instanceof HTMLElement ? node.dataset.status : 'error',
  }));
  check(applied.status === 'ok' && applied.text.endsWith('compiled build'),
    `the compiled build takes every authored value (${applied.text})`);
  return failures;
}

/** @param {import('puppeteer-core').Page} tab */
export async function probeDocumentActions(tab) {
  const { failures, check } = checks();
  const chip = '.chain-chip[data-label="rotate"]';
  const toggle = `${chip} .chain-chip-bypass`;
  await tab.click(toggle);
  await tab.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', {}, toggle);
  check(await tab.$eval(toggle, (node) => node.getAttribute('aria-pressed')) === 'true',
    'the bypass button bypasses the stage');
  await tab.focus(chip);
  await tab.keyboard.press('b');
  await tab.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-pressed') === 'false', {}, toggle);
  check(await tab.$eval(toggle, (node) => node.getAttribute('aria-pressed')) === 'false',
    'the b shortcut restores the stage');
  await tab.$eval(`${chip} .chain-chip-rename`, (node) => {
    node.value = 'camera-rotate';
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await tab.waitForSelector('.chain-chip[data-label="camera-rotate"]');
  await tab.click('.chain-undo');
  await tab.waitForSelector(chip);
  check(await tab.$(chip) !== null, 'undo restores the original stage name');
  await tab.click('.chain-redo');
  await tab.waitForSelector('.chain-chip[data-label="camera-rotate"]');
  check(await tab.$('.chain-chip[data-label="camera-rotate"]') !== null,
    'redo restores the renamed stage');
  const topology = await tab.$eval('select.chain-param-control', (node) => ({
    id: node.closest('.chain-param').dataset.parameter,
    value: [...node.options].find((option) => option.value !== node.value).value,
  }));
  await tab.select(`[data-parameter="${topology.id}"] select`, topology.value);
  const exported = await savedDocument(tab);
  check(exported.descriptor.chain[0].label === 'camera-rotate', 'rename reaches the saved chain');
  check(exported.preset_bank.presets[0].values[topology.id] === topology.value,
    'a topology select edit reaches the saved preset');
  const exportsBefore = await tab.evaluate(() => window.exported.length);
  await tab.click('#shader-document-save-as');
  await tab.waitForFunction((count) => window.exported.length > count, {}, exportsBefore);
  const copy = await tab.evaluate(async () => JSON.parse((await Promise.all(window.exported)).at(-1)));
  check(copy.document_id !== exported.document_id, 'Save As creates a distinct document id');
  await tab.evaluate(() => {
    window.copiedDigest = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async (text) => { window.copiedDigest = text; } } });
  });
  await tab.click('#shader-document-digest');
  await tab.waitForFunction(() => /^[a-f0-9]{64}$/.test(window.copiedDigest));
  check(await tab.evaluate(() => /^[a-f0-9]{64}$/.test(window.copiedDigest)),
    'the digest button copies the full descriptor digest');
  await tab.waitForFunction(() => location.hash.startsWith('#shader=v1.'));
  const linked = await tab.evaluate(async () => {
    const { decodeShaderStateHash } = await import('./shader_deeplink.js');
    return decodeShaderStateHash(location.hash);
  });
  check(linked.document.descriptor.chain[0].label === 'camera-rotate' && linked.bypassed.length === 0,
    'the live location hash preserves the edited chain and bypass state');
  return failures;
}

if (isMain(import.meta.url)) await runProbe({
  name: 'workbench-probe',
  minimumChecks: 60,
  page: PAGE,
  timeoutMs: TIMEOUT_MS,
  success: 'every pipeline control behaved.',
  run: async ({ open }) => {
    const failures = [];
    const openWorkbench = async () => {
      const tab = await open({ viewport: VIEWPORT });
      await tab.waitForFunction(() => !document.getElementById('loading-overlay'));
      await tab.waitForSelector('.chain-chip');
      return tab;
    };
    const actionsTab = await openWorkbench();
    failures.push(...await probeDocumentActions(actionsTab));
    await actionsTab.close();
    const historyTab = await openWorkbench();
    failures.push(...await probeStripHistory(historyTab));
    await historyTab.close();
    const tab = await openWorkbench();
    failures.push(...await probeStrip(tab));
    // A separate page: the strip probe's structural edits disarm the toggle.
    const parityTab = await openWorkbench();
    failures.push(...await probeParity(parityTab));
    return failures;
  },
});
