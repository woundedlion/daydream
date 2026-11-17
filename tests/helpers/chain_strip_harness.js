import {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createChainDocumentStore} from '../../src/workbench/shader/chain_document_store.js';
import {createChainStrip} from '../../src/workbench/shader/chain_strip.js';
import {compileShaderDocument} from '../../generated/shader/shader_workbench.mjs';
import {chainStudyDocument} from './chain_study.js';
import * as queries from './chain_strip_queries.js';
import {documentEvents, fakeElement, installAnimationFrames, installDocument, restoreDocumentAfterEach} from './fake_dom.js';

const CATALOG = JSON.parse(readFileSync(
  new URL('../../generated/shader/engine_catalog.json', import.meta.url), 'utf8'));
const BASE = compileShaderDocument(chainStudyDocument(CATALOG), { catalog: CATALOG });
assert.equal(BASE.status, 'VALID');

let frames = null;
beforeEach(() => { frames = installAnimationFrames(); });
afterEach(() => { frames.restore(); });
const runFrame = () => frames.flush();

restoreDocumentAfterEach();

/**
 * A strip over a fresh store on a fresh fixture copy, plus its spies.
 * @param {{presetId?: string|null, bypassAvailable?: () => boolean,
 *   writeThrough?: boolean, parameterLive?: (parameterId: string) => boolean,
 *   acceptParameter?: () => boolean, parameterRanges?: () => Object[], source?: Object,
 *   catalog?: Object}} [seams] - The preset the inline controls read,
 *   omitted the strip falls back to the document's first; whether a bypass
 *   reaches what is rendering; and whether inline edits reach the store as the
 *   page writes them; whether a parameter is live in the active build; whether
 *   the page accepts an inline edit (false models a refused write); the
 *   current parameter ranges; the document the store opens on; and its catalog.
 * @returns {Promise<Object>} The harness.
 */
async function makeStrip({
  presetId = null, bypassAvailable = () => true, writeThrough = false, parameterLive = () => true,
  acceptParameter = () => true,
  parameterRanges = () => [],
  source = structuredClone(BASE.document), catalog = CATALOG,
} = {}) {
  const store = await createChainDocumentStore({
    document: source, catalog });
  const container = fakeElement('section', { connected: true });
  const doc = installDocument({
    body: fakeElement('body', { connected: true }),
    activeElement: null,
    defaultView: documentEvents(),
    createElement: (/** @type {string} */ tag) => fakeElement(tag),
    ...documentEvents(),
  });
  const applied = [];
  const announced = [];
  const edits = [];
  const commits = [];
  const strip = createChainStrip({
    doc,
    container,
    store,
    catalog,
    announce: (message) => announced.push(message),
    onApply: () => applied.push(store.programShape().map((entry) => entry.instance)),
    presetId: () => presetId,
    onEditParameter: (parameterId, value) => {
      if (!acceptParameter()) return false;
      edits.push([parameterId, value]);
      if (!writeThrough) return;
      const target = presetId ?? store.document().preset_bank.presets[0].preset_id;
      assert.equal(store.setPresetValue(target, parameterId, value).ok, true);
    },
    onCommitParameter: () => commits.push(edits.length),
    bypassAvailable, parameterLive,
    parameterRanges,
  });
  return {
    store, container, doc, strip, applied, announced, edits, commits,
  };
}

const chips = (h) => queries.chips(h.container);
const chipByLabel = (h, label) => queries.chipByLabel(h.container, label);
const bandFor = (h, carrier) => queries.bandFor(h.container, carrier);
const paletteOf = (h) => h.container.querySelector('.chain-palette');
const paletteEntries = (h) => h.container.querySelectorAll('.chain-palette-entry');
const lastAnnounced = (h) => h.announced.at(-1) ?? '';
const labels = (h) => h.store.chain().map((entry) => entry.label);

const paramsOf = (h, label) => queries.paramsOf(h.container, label);
const rowsOf = (h, label) => queries.rowsOf(h.container, label);
const rowFor = (h, label, parameterId) => queries.rowFor(h.container, label, parameterId);
const declarationsFor = (h, label) => h.store.document().descriptor.parameters
  .filter((parameter) => parameter.id.startsWith(`${label}.`));

export {
  CATALOG, BASE, runFrame, makeStrip, chips, chipByLabel, bandFor, paletteOf, paletteEntries,
  lastAnnounced, labels, paramsOf, rowsOf, rowFor, declarationsFor,
};
export {controlIn} from './chain_strip_queries.js';
