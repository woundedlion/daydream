/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {errorDetail} from '../../shared/banner.js';
/** @typedef {import('./shader_document_state.js').ActiveDocument} ActiveDocument */

/** Creates Save and Save As over the current editor document.
 * @param {{state: import('./shader_document_state.js').PersistenceState,
 * win: *, flushDeepLink: () => Promise<*>, currentDocument: () => *, exportableDocument: () => *,
 * download: (filename: string, source: string) => void,
 * showStatus: (message: string) => void, showError: (message: string) => void}} dependencies */
export function createShaderDocumentPersistence({state, win, flushDeepLink,
  currentDocument, exportableDocument, download, showStatus, showError}) {
  let copies = 0;
  /**
   * @param {*} document - The document to write.
   * @param {string} filename - The download name.
   * @returns {boolean} Always true.
   */
  const exportDocument = (document, filename) => {
    download(filename, state.compiler.exportShaderDocumentJson(document));
    (/** @type {ActiveDocument} */ (state.active)).savedDocument = JSON.stringify(currentDocument());
    showStatus(`Saved ${filename}.`);
    return true;
  };

  const save = () => {
    if (!state.active) return false;
    void flushDeepLink();
    let document;
    try {
      document = exportableDocument();
    } catch (error) {
      showError(`The shader document could not be saved: ${errorDetail(error)}.`);
      return false;
    }
    return exportDocument(document, state.active.filename.endsWith('.shader.json')
      ? state.active.filename : `${document.effect_id ?? document.document_id}.shader.json`);
  };

  /**
   * Writes a copy under a fresh document id. The loaded document keeps its own
   * id and download name, so a following Save still re-exports the original.
   * @returns {Promise<boolean>} Whether a document was written.
   */
  const saveAs = async () => {
    if (!state.active) return false;
    void flushDeepLink();
    const savedActive = state.active;
    const savedDocument = JSON.stringify(currentDocument());
    try {
      const document = exportableDocument();
      document.document_id = `${document.document_id}-copy${copies + 1}`;
      let filename = `${document.document_id}.shader.json`;
      const source = state.compiler.exportShaderDocumentJson(document);
      if (typeof win.showSaveFilePicker === 'function') {
        const file = await win.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Shader document', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await file.createWritable();
        try {
          await writable.write(source);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
        filename = file.name;
      } else {
        const entered = win.prompt('Save shader as:', filename);
        if (entered === null) return false;
        filename = entered.trim();
        if (!filename) {
          showError('Enter a filename for the shader document.');
          return false;
        }
        if (!filename.toLowerCase().endsWith('.json')) filename += '.shader.json';
        download(filename, source);
      }
      copies += 1;
      if (state.active === savedActive) {
        state.active.savedDocument = savedDocument;
        showStatus(`Saved ${filename}.`);
      }
      return true;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError'))
        showError(`The shader document could not be saved: ${errorDetail(error)}.`);
      return false;
    }
  };
  return {save, saveAs};
}
