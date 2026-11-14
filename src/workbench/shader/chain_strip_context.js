// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {import('./chain_document_store.js').ParameterDeclaration} ParameterDeclaration */
/** @typedef {{focusLabel?: string|null, focusControl?: string|null, focusAction?: string|null}} RenderOptions */
/**
 * @typedef {Object} StripViewState
 * @property {string|null} focusedLabel
 * @property {ParameterDeclaration[]} declarations
 * @property {Record<string, number|string>} values
 * @property {Set<string>} pinnedLabels
 * @property {{remove: () => void}[]} drags
 */
/**
 * @typedef {Object} StripContext
 * @property {import('./chain_document_store.js').ChainStore} store
 * @property {StripViewState} view
 * @property {(message: string) => void} announce
 * @property {() => boolean} bypassAvailable
 * @property {(id: string) => boolean} parameterLive
 * @property {() => string|null} presetId
 * @property {(label: string|null, control?: string|null, action?: string|null) => true} commit
 * @property {ReturnType<typeof import('./chain_param_rows.js').createChainParamRows>} parameterRows
 */

export const BYPASS_UNAVAILABLE = 'Bypass applies to the interpreter only: '
  + 'the compiled build renders the whole chain.';

/** @returns {StripViewState} Mutable state shared across strip renders. */
export function createStripViewState() {
  return {focusedLabel: null, declarations: [], values: {}, pinnedLabels: new Set(), drags: []};
}
