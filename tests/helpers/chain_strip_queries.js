export const chips = (root) => root.querySelectorAll('.chain-chip');
export const chipByLabel = (root, label) =>
  chips(root).find((chip) => chip.dataset.label === label);
export const bandFor = (root, carrier) => root.querySelectorAll('.chain-band')
  .find((band) => band.dataset.carrier === carrier);

export const paramsOf = (root, label) =>
  chipByLabel(root, label).querySelector('.chain-chip-params');
export const rowsOf = (root, label) => paramsOf(root, label).querySelectorAll('.chain-param');
export const rowFor = (root, label, parameterId) =>
  rowsOf(root, label).find((row) => row.dataset.parameter === parameterId);
export const controlIn = (row) => row.querySelector('.chain-param-control');
