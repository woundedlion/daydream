/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { applyChainDocument } from './chain_apply.js';
import { createChainCatalogPanel } from './chain_catalog_panel.js';
import { deactivatedParamNames } from './chain_dock.js';
import { createChainDocumentStore } from './chain_document_store.js';
import { createChainEditor } from './chain_editor.js';

const MIGRATION_URL = '../shader/patterns/shaderball_migration.json';
const CATALOG_URL = '../shader/engine_catalog.json';
const COMPILER_URL = new URL('../shader/shader_workbench.mjs', import.meta.url).href;

// The effect the dynamic path previews on: the engine's chain interpreter,
// programmed through setShaderChain.
const CHAIN_EFFECT = 'ShaderChain';

// Topology enum8 parameters select an operator's structural variant. A fixed
// effect bakes its variants in, so the fixed path skips them; palette-mapping
// stays live as an ordinary dropdown.
const TOPOLOGY_FIELDS = new Set([
  'weight-mode', 'coverage-mode', 'basis', 'integrator', 'symmetry', 'mode',
  'hemisphere', 'palette-mode', 'hue-shift-mode', 'brightness-envelope',
]);

/** @param {string} parameterId */
const fieldSegment = (parameterId) =>
  parameterId.slice(parameterId.indexOf('.') + 1);

/** @typedef {{name: string, value?: *, readonly?: boolean, options?: string[]}} ParameterDefinition */
/** @typedef {{document: *, descriptor_digest?: string, diagnostics?: *, status?: string}} CompiledDocument */

/** @param {string} value */
function titleWords(value) {
  return value.split('-').map((part) => part.length === 0
    ? part : part[0].toUpperCase() + part.slice(1)).join(' ');
}

/**
 * Maps a v2 document parameter identity (`<label>.<field>`) to the control
 * name a pre-spec promoted effect registered. Newly promoted effects register
 * label-derived names, so this alias table only serves the effects promoted
 * before the chain schema and shrinks as they are re-registered.
 * @param {string} parameterId
 */
export function engineParameterName(parameterId) {
  const dot = parameterId.indexOf('.');
  if (dot < 0) return titleWords(parameterId);
  const label = parameterId.slice(0, dot);
  const field = parameterId.slice(dot + 1);
  if (label === 'warp1') return `Planar Warp 1 ${titleWords(field)}`;
  if (label === 'warp2') return `Planar Warp 2 ${titleWords(field)}`;
  if (label === 'surface') return `Surface Noise ${titleWords(field)}`;
  if (label === 'camera') return `Camera ${titleWords(field)}`;
  if (label === 'sample' && field === 'angle-speed') return 'Source Angle Speed';
  return titleWords(field);
}

/** @param {string} parameterId */
function engineParameterNames(parameterId) {
  const primary = engineParameterName(parameterId);
  const dot = parameterId.indexOf('.');
  if (dot < 0) return [primary];
  const label = parameterId.slice(0, dot);
  const field = parameterId.slice(dot + 1);
  if (label === 'warp1' || label === 'warp2') {
    const suffix = titleWords(field);
    if (['Rotation Rate', 'Translation X', 'Translation Y', 'Scale X', 'Scale Y', 'Shear']
        .includes(suffix)) return [primary, `Affine ${suffix}`];
    if (['Radial Scale', 'Radial Phase', 'Angular Phase'].includes(suffix))
      return [primary, `Polar ${suffix}`];
    if (['Rotation', 'Cell X', 'Cell Y', 'Offset X', 'Offset Y'].includes(suffix))
      return [primary, `Mirror ${suffix}`];
    if (['Strength', 'Frequency', 'Field Angle', 'Scale', 'Vector Angle'].includes(suffix))
      return [primary, `Warp ${suffix}`];
    return [primary, suffix];
  }
  return [primary];
}

/** @param {ParameterDefinition} definition @param {*} label */
function optionIndex(definition, label) {
  const wanted = String(label).toLowerCase();
  return definition.options?.findIndex((option) => option.toLowerCase() === wanted) ?? -1;
}

/** @param {*} module @param {*} result */
function paramSetResultName(module, result) {
  return Object.keys(module.ParamSetResult)
    .find((name) => module.ParamSetResult[name] === result) ?? 'unrecognized result';
}

/**
 * Writes one engine parameter.
 * @param {*} engine
 * @param {*} module - The loaded WASM module, for its ParamSetResult enum.
 *   setParameter answers one of its values; every value is a truthy object, so
 *   the outcome only reads as applied against APPLIED itself.
 * @param {ParameterDefinition[]} definitions
 * @param {string} name
 * @param {*} value
 * @returns {string|null} Refusal reason, or null once written.
 */
function writeEngineValue(engine, module, definitions, name, value) {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) return `the engine has no parameter "${name}"`;
  if (definition.readonly) return `"${name}" is read-only`;
  let stored = value;
  if (definition.options) {
    if (typeof value !== 'number') {
      const label = name === 'Palette Mapping' ? titleWords(String(value)) : value;
      stored = optionIndex(definition, label);
      if (stored < 0) return `"${name}" has no option "${label}"`;
    }
  }
  const result = engine.setParameter(name, stored);
  if (result === module.ParamSetResult.APPLIED) return null;
  return `"${name}" was refused: ${paramSetResultName(module, result)}`;
}

/**
 * @param {*} engine @param {*} module @param {CompiledDocument} compiled
 * @param {string} presetId
 * @returns {string|null} Refusal reason, or null once every value is written.
 */
function applyDocumentValues(engine, module, compiled, presetId) {
  const preset = compiled.document.preset_bank.presets
    .find((/** @type {*} */ candidate) => candidate.preset_id === presetId)
    ?? compiled.document.preset_bank.presets[0];
  const definitions = engine.getParameterDefinitions();
  for (const [parameterId, value] of Object.entries(preset?.values ?? {})) {
    if (TOPOLOGY_FIELDS.has(fieldSegment(parameterId))) continue;
    const name = engineParameterNames(parameterId)
      .find((candidate) => definitions.some(
        (/** @type {ParameterDefinition} */ definition) => definition.name === candidate));
    if (!name) return `no engine parameter matches "${parameterId}"`;
    const refusal = writeEngineValue(engine, module, definitions, name, value);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Applies one authored preset to a matching concrete fixed-pipeline effect.
 * @param {*} engine
 * @param {*} module
 * @param {CompiledDocument} compiled
 * @param {string} presetId
 * @param {string[]} referencePresetIds
 * @returns {string|null} Refusal reason, or null once applied.
 */
export function applyFixedShaderDocument(engine, module, compiled, presetId,
                                         referencePresetIds) {
  const referenceId = referencePresetIds.includes(presetId)
    ? presetId : referencePresetIds[0];
  if (typeof referenceId !== 'string') return 'the effect has no reference preset';
  if (engine.selectPresetById?.(referenceId) !== true)
    return `the engine refused reference preset "${referenceId}"`;
  return applyDocumentValues(engine, module, compiled, presetId);
}

/** @param {CompiledDocument} compiled */
function diagnosticText(compiled) {
  const diagnostic = compiled.diagnostics?.[0];
  if (!diagnostic) return compiled.status ?? 'INVALID';
  return `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`;
}

/** @param {Document} doc @param {string} filename @param {string} source */
function defaultDownload(doc, filename, source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/json' }));
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // The click starts the download asynchronously; the URL has to outlive it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Owns document import, validation, preview selection, editing, and export UI. */
/**
 * @param {{doc: Document, getEngine: () => *, getModule: () => *,
 * selectEffect: (effect: string) => boolean,
 * syncEffectGui: () => void, invalidate: () => void,
 * setParamFilter?: (filter: {prefix: string, deactivated?: Function}|null) => void,
 * fetchText?: (url: string) => Promise<string>, importCompiler?: () => Promise<*>,
 * download?: (filename: string, source: string) => void}} dependencies
 */
export function createShaderDocumentController({
  doc,
  getEngine,
  getModule,
  selectEffect,
  syncEffectGui,
  invalidate,
  setParamFilter = () => {},
  fetchText = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  },
  importCompiler = () => import(COMPILER_URL),
  download = (filename, source) => defaultDownload(doc, filename, source),
}) {
  const sourceSelect = /** @type {HTMLSelectElement|null} */ (
    doc.getElementById('shader-document-select'));
  const presetSelect = /** @type {HTMLSelectElement|null} */ (
    doc.getElementById('shader-preset-select'));
  const openButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-open'));
  const saveButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-save'));
  const fileInput = /** @type {HTMLInputElement|null} */ (
    doc.getElementById('shader-document-file'));
  const status = /** @type {HTMLOutputElement|null} */ (
    doc.getElementById('shader-document-status'));
  if (!sourceSelect || !presetSelect || !openButton || !saveButton
      || !fileInput || !status) return null;
  // The chain rail and catalog panel mount here on the workbench page; a page
  // without the mounts (or a compiler without the validator) previews documents
  // but offers no structural editing.
  const editorMount = doc.getElementById('chain-editor');
  const catalogMount = doc.getElementById('chain-catalog');

  /** @type {*} */
  let compiler;
  /** @type {*|null} */
  let active = null;
  /** @type {Map<string, *>} */
  let catalog = new Map();
  /** @type {*|null} */
  let operatorCatalog = null;
  /** @type {{store: *, editor: *, panel: *}|null} */
  let chainUi = null;

  /** @param {string} message @param {boolean} [error] */
  const show = (message, error = false) => {
    status.textContent = message;
    status.dataset.status = error ? 'error' : 'ok';
  };

  /** @param {CompiledDocument} compiled */
  const populatePresets = (compiled) => {
    presetSelect.replaceChildren();
    for (const preset of compiled.document.preset_bank.presets) {
      const option = doc.createElement('option');
      option.value = preset.preset_id;
      option.textContent = preset.display_name;
      presetSelect.appendChild(option);
    }
    presetSelect.disabled = presetSelect.options.length === 0;
  };

  /** @param {string} presetId */
  const applyPreset = (presetId) => {
    const engine = getEngine();
    const module = getModule();
    if (!engine || !module || !active) {
      show('The preview engine is not ready.', true);
      return false;
    }
    // applyChainDocument owns the GUI resync and repaint (its apply order is
    // fixed); the fixed path runs them here. With the editor live, the store's
    // document is the authority (the imported compile goes stale on the first
    // structural edit) and its program shape carries the session bypasses.
    const store = chainUi?.store ?? null;
    const refusal = active.fixed
      ? applyFixedShaderDocument(
        engine, module, active.compiled, presetId, active.referencePresetIds)
      : applyChainDocument({
        engine, module,
        compiled: store ? { document: store.document() } : active.compiled,
        programShape: store ? store.programShape() : null,
        presetId, syncEffectGui, invalidate,
      });
    if (refusal) {
      show(`Preset "${presetId}" could not be applied: ${refusal}`, true);
      return false;
    }
    if (active.fixed) {
      syncEffectGui();
      invalidate();
    }
    active.presetId = presetId;
    const title = active.compiled.document.effect_metadata?.display_name
      ?? active.compiled.document.document_id;
    show(`${title} · ${presetSelect.selectedOptions[0]?.textContent ?? presetId}`);
    return true;
  };

  const teardownChainUi = () => {
    if (chainUi === null) return;
    chainUi.editor.destroy();
    chainUi.panel.destroy();
    chainUi = null;
    setParamFilter(null);
  };

  // The catalog panel's click-insert legality tracks the drop context: the gap
  // after the selected card. No selection clears it, leaving every entry
  // draggable and click-inserting at the first legal gap.
  const refreshCatalogLegality = () => {
    if (chainUi === null) return;
    const selected = chainUi.store.selectedLabel();
    if (selected === null) {
      chainUi.panel.setLegality(null);
      return;
    }
    const gap = chainUi.store.chain()
      .findIndex((/** @type {*} */ entry) => entry.label === selected) + 1;
    chainUi.panel.setLegality(chainUi.store.legalInsertions(gap));
  };

  /**
   * Builds the chain rail and catalog panel over one document store, wiring
   * every structural edit, undo and bypass toggle back through the one apply
   * path and the selection into the parameter GUI's instance filter.
   * @param {*} document - The compiled (valid) v2 document to edit.
   */
  const buildChainUi = async (document) => {
    const store = /** @type {*} */ (await createChainDocumentStore({
      document, catalog: operatorCatalog, importCompiler,
    }));
    const editor = /** @type {*} */ (createChainEditor({
      doc,
      container: editorMount,
      store,
      catalog: operatorCatalog,
      onApply: () => {
        applyPreset(active?.presetId ?? presetSelect.value);
        refreshCatalogLegality();
      },
      onSelect: (/** @type {string|null} */ label) => {
        setParamFilter(label === null
          ? null : { prefix: `${label}.`, deactivated: deactivatedParamNames });
        syncEffectGui();
        refreshCatalogLegality();
      },
    }));
    const panel = createChainCatalogPanel({
      doc,
      container: catalogMount,
      catalog: operatorCatalog,
      drag: editor.drag,
      onPick: (/** @type {string} */ operatorId) => editor.insertOperator(operatorId),
    });
    chainUi = { store, editor, panel };
  };

  /**
   * @param {string} source @param {string} [filename]
   * @param {*} [precompiled] - The catalog's already-compiled document, when the
   *   source is a catalog entry rather than an imported study.
   */
  const loadSource = async (source, filename = 'import.shader.json',
                            precompiled = null) => {
    compiler ??= await importCompiler();
    const compiled = precompiled
      ?? compiler.compileShaderDocument(source, { catalog: operatorCatalog });
    if (compiled.status !== 'VALID') {
      show(diagnosticText(compiled), true);
      return false;
    }
    // The digest tells an authored study from a shipped pattern: a match
    // routes the preview onto the concrete fixed-pipeline effect, anything
    // else onto the chain interpreter.
    const official = [...catalog.values()].find((candidate) =>
      candidate.descriptorDigest === compiled.descriptor_digest);
    const fixed = official !== undefined;
    const effect = fixed ? official.effectId : CHAIN_EFFECT;
    teardownChainUi();
    if (!selectEffect(effect)) {
      show(`The preview engine rejected effect "${effect}".`, true);
      return false;
    }
    active = {
      compiled,
      filename,
      fixed,
      presetId: null,
      referencePresetIds: fixed ? official.presetIds ?? [] : [],
    };
    populatePresets(compiled);
    saveButton.disabled = false;
    if (!fixed && editorMount && catalogMount
        && typeof compiler.validateShaderDocument === 'function') {
      try {
        await buildChainUi(compiled.document);
        refreshCatalogLegality();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        show(`The chain editor could not adopt the document: ${detail}`, true);
        return false;
      }
    }
    const presetId = compiled.document.preset_bank.presets[0]?.preset_id;
    if (!presetId) {
      show('The document is valid, but it carries no preset to preview.', true);
      return false;
    }
    return applyPreset(presetId);
  };

  const save = () => {
    if (!active) return false;
    // With the editor live, the store's document carries every structural edit
    // and reconciliation; the imported compile is only the load-time snapshot.
    const document = chainUi
      ? chainUi.store.document()
      : structuredClone(active.compiled.document);
    const preset = document.preset_bank.presets
      .find((/** @type {*} */ candidate) => candidate.preset_id === active.presetId);
    if (preset) {
      const definitions = getEngine()?.getParameterDefinitions?.() ?? [];
      for (const parameterId of Object.keys(preset.values)) {
        // The chain path registers the parameter id itself; the alias names
        // only serve the pre-spec promoted effects on the fixed path.
        const names = active.fixed ? engineParameterNames(parameterId) : [parameterId];
        const definition = definitions.find(
          (/** @type {ParameterDefinition} */ candidate) => names.includes(candidate.name));
        if (!definition) continue;
        if (definition.options && typeof preset.values[parameterId] === 'string') {
          // A document enum value is the option id; the fixed path's Palette
          // Mapping labels are Title Case spellings of it, the chain path's
          // options are the ids themselves.
          const option = definition.options[definition.value];
          preset.values[parameterId] = active.fixed ? option?.toLowerCase() : option;
        } else {
          preset.values[parameterId] = definition.value;
        }
      }
    }
    const filename = active.filename.endsWith('.shader.json')
      ? active.filename : `${document.effect_id}.shader.json`;
    download(filename, `${JSON.stringify(document, null, 2)}\n`);
    show(`Saved ${filename}.`);
    return true;
  };

  const init = async () => {
    try {
      compiler = await importCompiler();
      operatorCatalog = JSON.parse(await fetchText(CATALOG_URL));
      const migration = JSON.parse(await fetchText(MIGRATION_URL));
      const entries = await Promise.all(Object.entries(migration.source_documents)
        .map(async ([effectId, filename]) => {
          const source = await fetchText(`../shader/patterns/${filename}`);
          const compiled = compiler.compileShaderDocument(source,
            { catalog: operatorCatalog });
          if (compiled.status !== 'VALID')
            throw new Error(`${filename}: ${diagnosticText(compiled)}`);
          return [effectId, filename, source, compiled];
        }));
      catalog = new Map(entries.map(([effectId, filename, source, compiled]) =>
        [effectId, {
          effectId,
          filename,
          source,
          compiled,
          descriptorDigest: compiled.descriptor_digest,
          presetIds: compiled.document.preset_bank.presets.map(
            (/** @type {*} */ preset) => preset.preset_id),
        }]));
      for (const [effectId] of entries) {
        const option = doc.createElement('option');
        option.value = effectId;
        option.textContent = migration.product_group.children
          .find((/** @type {*} */ child) => child.effect_id === effectId)?.display_name
          ?? effectId;
        sourceSelect.appendChild(option);
      }
      show('Choose a source document or open a local study.');
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      show(`Source catalog failed to load: ${detail}`, true);
      return false;
    }
  };

  sourceSelect.addEventListener('change', async () => {
    const option = sourceSelect.selectedOptions[0];
    if (!option?.value) {
      teardownChainUi();
      selectEffect('Shader');
      active = null;
      presetSelect.replaceChildren();
      presetSelect.disabled = true;
      saveButton.disabled = true;
      show('Scratch Shader is active.');
      return;
    }
    const entry = catalog.get(option.value);
    if (!entry) {
      show(`The source catalog carries no document for "${option.value}".`, true);
      return;
    }
    await loadSource(entry.source, entry.filename, entry.compiled);
  });
  presetSelect.addEventListener('change', () => {
    applyPreset(presetSelect.value);
  });
  openButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    sourceSelect.value = '';
    await loadSource(await file.text(), file.name);
    fileInput.value = '';
  });
  saveButton.addEventListener('click', save);

  return { init, loadSource, save, applyPreset };
}
