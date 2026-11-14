/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Shader document controller state and the views its collaborators receive. */

/** @typedef {import('./chain_apply.js').CompiledDocument} CompiledDocument */

/**
 * The promoted effect a loaded document's descriptor digest matches.
 * @typedef {{effectId: string, descriptorDigest?: string, presetIds: string[]}} OfficialDocument
 */

/**
 * The document on screen and its preview selection.
 * @typedef {{compiled: CompiledDocument, filename: string, official: OfficialDocument|null,
 *   compiledSide: boolean, presetId: string|null, referencePresetIds: string[],
 *   savedDocument?: string|null}} ActiveDocument
 */

/**
 * The live chain editor: its document store and strip.
 * @typedef {{store: import('./chain_document_store.js').ChainStore, strip: *}} ChainUi
 */

/**
 * One source-catalog document, compiled at init.
 * @typedef {{effectId: string, filename: string, source: string, compiled: *,
 *   descriptorDigest: string, presetIds: string[]}} SourceEntry
 */

/**
 * Mutable state the document controller owns.
 * @typedef {Object} DocumentControllerState
 * @property {ActiveDocument|null} active - The document on screen.
 * @property {ChainUi|null} chainUi - The live editor, once a document is adopted.
 * @property {*} compiler - The shader workbench module, once imported.
 * @property {*} operatorCatalog - The engine operator catalog, once loaded.
 * @property {Map<string, SourceEntry>} sourceCatalog - Catalog documents by effect id.
 * @property {*|null} cachedDocumentDefinitions - Compiled-build document
 *   definitions, cleared whenever the engine's parameters may have changed.
 * @property {boolean} rebuildAfterParameterCommit - Whether the strip re-renders
 *   once the pending slider edit commits.
 */

/** @typedef {Pick<DocumentControllerState, 'active'|'chainUi'|'compiler'|'operatorCatalog'|'cachedDocumentDefinitions'|'rebuildAfterParameterCommit'>} EditorState */
/** @typedef {Pick<DocumentControllerState, 'active'|'chainUi'|'compiler'|'operatorCatalog'|'sourceCatalog'>} LoaderState */
/** @typedef {Pick<DocumentControllerState, 'active'|'chainUi'>} LinkState */
/** @typedef {Pick<DocumentControllerState, 'active'|'compiler'>} PersistenceState */

/**
 * Fresh controller state, before the compiler and catalogs load.
 * @returns {DocumentControllerState} The state.
 */
export function createDocumentControllerState() {
  return {
    active: null,
    chainUi: null,
    compiler: undefined,
    operatorCatalog: null,
    sourceCatalog: new Map(),
    cachedDocumentDefinitions: null,
    rebuildAfterParameterCommit: false,
  };
}
