/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {errorDetail} from '../../shared/banner.js';

/** Creates the clipboard export action for the current shader document.
 * @param {{state: import('./shader_document_state.js').PersistenceState,
 * flushDeepLink: () => Promise<*>, currentDocument: () => *, exportableDocument: () => *,
 * copyText: (source: string) => Promise<boolean>,
 * showStatus: (message: string) => void, showError: (message: string) => void}} dependencies */
export function createShaderDocumentPersistence({state, flushDeepLink,
  currentDocument, exportableDocument, copyText, showStatus, showError}) {
  let exporting = false;

  return async () => {
    const active = state.active;
    if (!active || exporting) return false;
    exporting = true;
    try {
      void flushDeepLink();
      const documentBaseline = JSON.stringify(currentDocument());
      const source = state.compiler.exportShaderDocumentJson(exportableDocument());
      if (!await copyText(source)) {
        if (state.active === active) showError('The shader document could not be copied to the clipboard.');
        return false;
      }
      if (state.active === active) {
        active.documentBaseline = documentBaseline;
        showStatus('Copied the shader document to the clipboard.');
      }
      return true;
    } catch (error) {
      if (state.active === active)
        showError(`The shader document could not be exported: ${errorDetail(error)}`);
      return false;
    } finally {
      exporting = false;
    }
  };
}
