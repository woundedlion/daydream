import { fakeElement } from "../helpers/fake_dom.js";
import { CATALOG, chipByLabel, bandFor, paramsOf } from "../helpers/chain_strip_harness.js";
import { STUDY_CHAIN } from "../helpers/chain_study.js";

export const PROJECT = STUDY_CHAIN.findIndex((entry) => entry.label === 'project');
export const SAMPLE = STUDY_CHAIN.findIndex((entry) => entry.label === 'sample');

/** @param {string} label @returns {string} The catalog name of the study stage's operator. */
export const operatorName = (label) => CATALOG.operators.find((operator) =>
  operator.id === STUDY_CHAIN.find((entry) => entry.label === label).operator).name;

/**
 * @param {Object} h - A strip harness.
 * @param {number} width - Width every created element reports.
 * @returns {void}
 * @details Written as the box metrics the fake derives its whole rect from, so
 *   a measurement the module starts taking is answered rather than undefined.
 */
export const measureNewElements = (h, width) => {
  h.doc.documentElement = { clientWidth: 1280 };
  h.doc.createElement = (/** @type {string} */ tag) => {
    const node = fakeElement(tag);
    node.offsetWidth = width;
    return node;
  };
};

/**
 * Measures every created element at one unconstrained height, capped by the
 * max-height the strip writes: a max-height only ever shrinks a box.
 * @param {Object} h - A strip harness.
 * @param {number} height - The unconstrained height.
 * @returns {void}
 */
export const measureNewHeights = (h, height) => {
  h.doc.createElement = (/** @type {string} */ tag) => {
    const node = fakeElement(tag);
    node.offsetWidth = 208;
    Object.defineProperty(node, 'offsetHeight', {
      get: () => Math.min(height, Number.parseFloat(node.style.maxHeight) || height),
    });
    return node;
  };
};

export const rect = (top, height = 30, left = 10, width = 200) => ({
  top, bottom: top + height, left, right: left + width, width, height,
});

export const dragGeometry = (h, carrier = 'sphere', labels = ['camera', 'lens']) => {
  const band = bandFor(h, carrier);
  band.getBoundingClientRect = () => rect(0, 140);
  for (const [index, label] of labels.entries()) {
    const top = 20 + index * 50;
    const chip = chipByLabel(h, label);
    chip.getBoundingClientRect = () => rect(top);
    chip.querySelector('.chain-chip-header').getBoundingClientRect = () => rect(top, 20);
  }
  const viewport = h.container.querySelector('.chain-strip-viewport');
  viewport.getBoundingClientRect = () => rect(0, 200);
  viewport.clientHeight = viewport.scrollHeight = 200;
};

export const dragPointer = (clientY, extra = {}) => ({
  clientX: 20, clientY, pointerId: 7, isPrimary: true, button: 0, ...extra,
});

export const renameIn = (h, label) =>
  paramsOf(h, label).querySelector('.chain-chip-rename');
