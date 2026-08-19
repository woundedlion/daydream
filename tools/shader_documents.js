/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { applyChainDocument } from './chain_apply.js';
import { createParameterDock, deactivatedParamNames } from './chain_dock.js';
import { createChainDocumentStore, scratchChainDocument } from './chain_document_store.js';
import { createChainLibrary } from './chain_library.js';
import { createChainStrip } from './chain_strip.js';
import { copyToClipboard } from './copy_text.js';

const MIGRATION_URL = '../shader/patterns/shaderball_migration.json';
const CATALOG_URL = '../shader/engine_catalog.json';
const COMPILER_URL = new URL('../shader/shader_workbench.mjs', import.meta.url).href;

// The effect the dynamic path previews on: the engine's chain interpreter,
// programmed through setShaderChain.
const CHAIN_EFFECT = 'ShaderChain';

// Digest characters the toolbar shows; the button copies all of it.
const DIGEST_ABBREVIATION = 12;

// The download name the scratch document exports under until Save As renames it.
const SCRATCH_FILENAME = 'scratch.shader.json';

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
 * setParamFilter?: (filter: {prefix: string, deactivated?: Function,
 *   onEdit?: (name: string, value: *) => void}|null) => void,
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
  const digestButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-digest'));
  if (!sourceSelect || !presetSelect || !openButton || !saveButton
      || !fileInput || !status) return null;
  // The pipeline strip, the stage library and the parameter dock mount here on
  // the workbench page; a page without the mounts (or a compiler without the
  // validator) previews documents but offers no structural editing.
  const stripMount = doc.getElementById('chain-strip');
  const libraryMount = doc.getElementById('chain-library');
  const dockMount = doc.getElementById('parameter-dock');
  const dockToggle = doc.getElementById('parameter-dock-toggle');

  /** @type {*} */
  let compiler;
  /** @type {*|null} */
  let active = null;
  /** @type {Map<string, *>} */
  let catalog = new Map();
  /** @type {*|null} */
  let operatorCatalog = null;
  /** @type {{store: *, strip: *, library: *, dock: *}|null} */
  let chainUi = null;

  /** @param {string} message @param {boolean} [error] */
  const show = (message, error = false) => {
    status.textContent = message;
    status.dataset.status = error ? 'error' : 'ok';
  };

  // The one shared live region: the strip, the library and the dock all report
  // through it, and an empty message clears it.
  /** @param {string} message */
  const announce = (message) => show(message, message !== '');

  /**
   * Repaints the toolbar digest from whichever document is authoritative: the
   * store's once the editor is live, else the load-time compile.
   * @returns {void}
   */
  const showDigest = () => {
    if (!digestButton) return;
    const digest = chainUi
      ? chainUi.store.compile().descriptor_digest
      : active?.compiled.descriptor_digest;
    digestButton.dataset.digest = digest ?? '';
    digestButton.textContent = digest ? digest.slice(0, DIGEST_ABBREVIATION) : '—';
    digestButton.disabled = !digest;
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
    showDigest();
    return true;
  };

  const teardownChainUi = () => {
    if (chainUi === null) return;
    chainUi.strip.destroy();
    chainUi.library.destroy();
    chainUi.dock?.destroy();
    chainUi = null;
    setParamFilter(null);
  };

  // The library's click-insert legality tracks the drop context: the gap after
  // the selected chip. No selection clears it, leaving every entry draggable
  // and click-inserting at the first legal gap.
  const refreshLibraryLegality = () => {
    if (chainUi === null) return;
    const selected = chainUi.store.selectedLabel();
    if (selected === null) {
      chainUi.library.setLegality(null);
      return;
    }
    const gap = chainUi.store.chain()
      .findIndex((/** @type {*} */ entry) => entry.label === selected) + 1;
    chainUi.library.setLegality(chainUi.store.legalInsertions(gap));
  };

  /**
   * The catalog schema behind a chain parameter id, which is `<label>.<field>`
   * over the labelled instance's operator.
   * @param {string} parameterId - A chain parameter id.
   * @returns {*|null} The catalog field, or null when nothing declares it.
   */
  const catalogField = (parameterId) => {
    if (chainUi === null) return null;
    const dot = parameterId.indexOf('.');
    if (dot < 0) return null;
    const entry = chainUi.store.chain().find(
      (/** @type {*} */ candidate) => candidate.label === parameterId.slice(0, dot));
    return operatorCatalog.operators
      .find((/** @type {*} */ op) => op.id === entry?.operator)?.params
      .find((/** @type {*} */ field) => field.id === parameterId.slice(dot + 1)) ?? null;
  };

  /**
   * Routes a parameter-dock edit into the active preset: the document is the
   * source of truth and the engine write, which the dock has already made, is
   * the side effect. The chain path registers each parameter id verbatim as its
   * control name, so no alias translation stands between the two.
   * @param {string} parameterId - The edited control's name.
   * @param {*} value - The control's value; an enum carries an option index into
   *   the operator's catalog values, which is the order the chain registers its
   *   options in.
   * @returns {void}
   */
  const writeDockEdit = (parameterId, value) => {
    if (chainUi === null || active === null || active.presetId === null) return;
    const values = catalogField(parameterId)?.values;
    const stored = values && typeof value === 'number' ? values[value] : value;
    const undoable = chainUi.store.canUndo();
    const redoable = chainUi.store.canRedo();
    const result = chainUi.store.setPresetValue(active.presetId, parameterId, stored);
    if (!result.ok) {
      announce(`"${parameterId}" was refused: ${result.diagnostics[0].message}`);
      return;
    }
    // A drag calls this per pointermove; only the write that opens the undo
    // run moves the strip's history buttons.
    if (undoable !== chainUi.store.canUndo() || redoable !== chainUi.store.canRedo())
      chainUi.strip.render();
  };

  /**
   * Builds the pipeline strip, the stage library and the parameter dock over one
   * document store, wiring every structural edit, undo and bypass toggle back
   * through the one apply path and the selection into the parameter GUI's
   * instance filter.
   * @param {*} document - The compiled (valid) v2 document to edit.
   */
  const buildChainUi = async (document) => {
    const store = /** @type {*} */ (await createChainDocumentStore({
      document, catalog: operatorCatalog, importCompiler,
    }));
    const strip = /** @type {*} */ (createChainStrip({
      doc,
      container: stripMount,
      store,
      catalog: operatorCatalog,
      announce,
      onApply: () => {
        applyPreset(active?.presetId ?? presetSelect.value);
        refreshLibraryLegality();
      },
      onSelect: (/** @type {string|null} */ label) => {
        setParamFilter(label === null ? null : {
          prefix: `${label}.`,
          deactivated: deactivatedParamNames,
          onEdit: writeDockEdit,
        });
        syncEffectGui();
        refreshLibraryLegality();
        if (label !== null) chainUi?.dock?.setCollapsed(false);
      },
    }));
    const library = createChainLibrary({
      doc,
      container: libraryMount,
      catalog: operatorCatalog,
      drag: strip.drag,
      announce,
      onPick: (/** @type {string} */ operatorId) => strip.insertOperator(operatorId),
    });
    const dock = dockMount && dockToggle
      ? createParameterDock({ doc, container: dockMount, toggle: dockToggle })
      : null;
    chainUi = { store, strip, library, dock };
  };

  /**
   * @param {string|*} source - Document JSON, or the document itself.
   * @param {string} [filename]
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
    showDigest();
    if (!fixed && stripMount && libraryMount
        && typeof compiler.validateShaderDocument === 'function') {
      try {
        await buildChainUi(compiled.document);
        refreshLibraryLegality();
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
    // Every edit is already a document edit, so the export is the document as
    // it stands — the store's once the editor is live, else the load-time
    // compile — with nothing harvested back out of the engine.
    const document = chainUi
      ? chainUi.store.document()
      : structuredClone(active.compiled.document);
    const filename = active.filename.endsWith('.shader.json')
      ? active.filename : `${document.effect_id}.shader.json`;
    download(filename, `${JSON.stringify(document, null, 2)}\n`);
    show(`Saved ${filename}.`);
    return true;
  };

  /**
   * Opens the default chain on catalog defaults through the ordinary load path,
   * so an unnamed session authors against the same strip, library and dock a
   * loaded document gets.
   * @returns {Promise<boolean>} Whether the scratch document is on screen.
   */
  const loadScratch = () =>
    loadSource(scratchChainDocument(operatorCatalog), SCRATCH_FILENAME);

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
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      show(`Source catalog failed to load: ${detail}`, true);
      return false;
    }
    return loadScratch();
  };

  sourceSelect.addEventListener('change', async () => {
    const option = sourceSelect.selectedOptions[0];
    if (!option?.value) {
      await loadScratch();
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
  digestButton?.addEventListener('click', async () => {
    const digest = digestButton.dataset.digest;
    if (!digest) return;
    if (await copyToClipboard(digest)) show(`Copied the descriptor digest ${digest}.`);
    else announce('The descriptor digest could not be copied.');
  });

  return { init, loadSource, save, applyPreset };
}
