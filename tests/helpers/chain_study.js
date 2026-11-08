import { scratchChainDocument } from '../../src/workbench/shader/chain_document_store.js';

/**
 * The test-owned study chain: every carrier band, a lens, a plane warp and a
 * colour modulation stage.
 * @type {ReadonlyArray<{label: string, operator: string}>}
 */
export const STUDY_CHAIN = Object.freeze([
  { label: 'camera', operator: 'sphere.rotate.v2' },
  { label: 'lens', operator: 'sphere.lens.kaleidoscope.v2' },
  { label: 'project', operator: 'project.stereographic.v2' },
  { label: 'warp2', operator: 'warp.mirror-tile.v2' },
  { label: 'sample', operator: 'sample.twin-wave.v3' },
  { label: 'colorize', operator: 'colorize.generated-palette.v4' },
  { label: 'modulation', operator: 'color.modulate.v1' },
]);

/**
 * The study document over the given catalog: the study chain on catalog
 * defaults, with the sample stage's last numeric catalog field left undeclared.
 * @param {*} catalog - The operator catalog.
 * @returns {*} A fresh v2 document.
 */
export function chainStudyDocument(catalog) {
  const document = scratchChainDocument(catalog, STUDY_CHAIN);
  document.document_id = 'chain-study';
  document.effect_id = 'chain-study';
  document.effect_metadata = { display_name: 'Chain Study', description: 'A test-owned chain.' };
  const omitted = document.descriptor.parameters.filter(
    (/** @type {{id: string, storage: string}} */ parameter) =>
      parameter.id.startsWith('sample.') && parameter.storage === 'binary32').at(-1).id;
  return withoutDeclaration(document, omitted);
}

/**
 * Removes one parameter's declaration, serialization field and preset values.
 * @param {*} document - The document to edit in place.
 * @param {string} parameterId - The parameter to leave undeclared.
 * @returns {*} The document.
 */
export function withoutDeclaration(document, parameterId) {
  const { descriptor, preset_bank: bank } = document;
  descriptor.parameters = descriptor.parameters.filter(
    (/** @type {{id: string}} */ parameter) => parameter.id !== parameterId);
  descriptor.serialization.fields = descriptor.serialization.fields.filter(
    (/** @type {string} */ id) => id !== parameterId);
  for (const preset of bank.presets) delete preset.values[parameterId];
  return document;
}

/**
 * Adds a preset to a document: a copy of its first preset with the given
 * values, appended to the generated order.
 * @param {*} document - The document to extend in place.
 * @param {string} presetId - The new preset's id.
 * @param {Object<string, *>} [values] - Values that differ from the first preset.
 * @returns {*} The document.
 */
export function withPreset(document, presetId, values = {}) {
  const bank = document.preset_bank;
  bank.presets.push({
    preset_id: presetId,
    display_name: presetId,
    values: { ...bank.presets[0].values, ...values },
  });
  bank.choreography.generated_order.push(presetId);
  bank.choreography.dwell[presetId] = bank.choreography.dwell[bank.presets[0].preset_id];
  return document;
}
