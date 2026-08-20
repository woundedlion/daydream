/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { applyChainDocument } from './chain_apply.js';
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
 * setParamFilter?: (filter: {external: true}|null) => void,
 * fetchText?: (url: string) => Promise<string>, importCompiler?: () => Promise<*>,
 * download?: (filename: string, source: string) => void,
 * initialEffect?: string|null}} dependencies - initialEffect is the effect the
 *   page was opened on, which init() honors when it names a catalog source.
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
  initialEffect = null,
}) {
  const sourceSelect = /** @type {HTMLSelectElement|null} */ (
    doc.getElementById('shader-document-select'));
  const presetSelect = /** @type {HTMLSelectElement|null} */ (
    doc.getElementById('shader-preset-select'));
  const openButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-open'));
  const saveButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-save'));
  const saveAsButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-save-as'));
  const fileInput = /** @type {HTMLInputElement|null} */ (
    doc.getElementById('shader-document-file'));
  const status = /** @type {HTMLOutputElement|null} */ (
    doc.getElementById('shader-document-status'));
  const digestButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-digest'));
  const parityToggle = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-parity-toggle'));
  if (!sourceSelect || !presetSelect || !openButton || !saveButton
      || !fileInput || !status) return null;
  // The pipeline strip and the stage library mount here on the workbench page;
  // a page without the mounts (or a compiler without the validator) previews
  // documents but offers no structural editing.
  const stripMount = doc.getElementById('chain-strip');
  const libraryMount = doc.getElementById('chain-library');

  /** @type {*} */
  let compiler;
  /** @type {*|null} */
  let active = null;
  /** @type {Map<string, *>} */
  let catalog = new Map();
  /** @type {*|null} */
  let operatorCatalog = null;
  /** @type {{store: *, strip: *, library: *}|null} */
  let chainUi = null;
  /** @type {number} Save As copies this session, which their ids count off. */
  let copies = 0;

  /** @param {string} message @param {boolean} [error] */
  const show = (message, error = false) => {
    status.textContent = message;
    status.dataset.status = error ? 'error' : 'ok';
  };

  // The one shared live region: the strip and the library both report through
  // it, and an empty message clears it.
  /** @param {string} message */
  const announce = (message) => show(message, message !== '');

  /**
   * The descriptor digest of whichever document is authoritative: the store's
   * once the editor is live, else the load-time compile.
   * @returns {string|undefined} The digest.
   */
  const liveDigest = () => chainUi
    ? chainUi.store.compile().descriptor_digest
    : active?.compiled.descriptor_digest;

  /**
   * Whether the loaded chain still digests to the promoted effect it opened as.
   * Bypass is a program-shape override that never touches the document, so it
   * leaves this true; the first descriptor-changing edit does not.
   * @returns {boolean} Whether the parity toggle is armed.
   */
  const parityArmed = () =>
    active?.official != null && liveDigest() === active.loadedDigest;

  /**
   * Repaints the parity toggle and, once a descriptor edit has broken the
   * match, returns the preview to the interpreter so the render is the document
   * being edited.
   * @returns {boolean} Whether the compiled build was dropped.
   */
  const syncParity = () => {
    const armed = parityArmed();
    const dropped = !armed && active?.compiledSide === true;
    if (dropped && active) {
      active.compiledSide = false;
      selectEffect(CHAIN_EFFECT);
    }
    if (parityToggle) {
      parityToggle.disabled = !armed;
      parityToggle.setAttribute('aria-pressed', String(active?.compiledSide === true));
    }
    return dropped;
  };

  /**
   * Repaints the toolbar digest.
   * @returns {void}
   */
  const showDigest = () => {
    if (!digestButton) return;
    const digest = liveDigest();
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
    const refusal = active.compiledSide
      ? applyFixedShaderDocument(
        engine, module, store ? { document: store.document() } : active.compiled,
        presetId, active.referencePresetIds)
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
    if (active.compiledSide) {
      syncEffectGui();
      invalidate();
    }
    active.presetId = presetId;
    const title = active.compiled.document.effect_metadata?.display_name
      ?? active.compiled.document.document_id;
    const preset = presetSelect.selectedOptions[0]?.textContent ?? presetId;
    // Only an armed toggle leaves which build is rendering in question.
    const side = !parityArmed() ? ''
      : active.compiledSide ? ' · compiled build' : ' · interpreter';
    show(`${title} · ${preset}${side}`);
    showDigest();
    return true;
  };

  const teardownChainUi = () => {
    if (chainUi === null) return;
    chainUi.strip.destroy();
    chainUi.library.destroy();
    chainUi = null;
    setParamFilter(null);
  };

  // The library's legality is the chain's, not one gap's: a click lands the
  // operator wherever the chain takes it, the first accepting gap or the socket
  // a crossing's carrier pair names, so only what neither route reaches is
  // disabled.
  const refreshLibraryLegality = () => {
    if (chainUi === null) return;
    chainUi.library.setLegality(chainUi.strip.insertionLegality());
  };

  /**
   * The live preview's control name for a document parameter: the interpreter
   * registers each id verbatim, while the compiled build takes its own control
   * names and bakes the topology fields in, so those reach no control there.
   * @param {string} parameterId - A chain parameter id.
   * @param {ParameterDefinition[]} definitions - The engine's definitions.
   * @returns {string|null} The control name, or null where none takes the value.
   */
  const engineControlName = (parameterId, definitions) => {
    if (active?.compiledSide !== true) return parameterId;
    if (TOPOLOGY_FIELDS.has(fieldSegment(parameterId))) return null;
    return engineParameterNames(parameterId).find((candidate) =>
      definitions.some((definition) => definition.name === candidate)) ?? null;
  };

  /**
   * Routes an inline stage-control edit into the active preset: the document is
   * the source of truth and the engine write is its side effect.
   * @param {string} parameterId - The edited parameter's id.
   * @param {*} value - The document value: a number, or an enum8 option id.
   * @returns {void}
   */
  const writeStageEdit = (parameterId, value) => {
    if (chainUi === null || active === null || active.presetId === null) return;
    const result = chainUi.store.setPresetValue(active.presetId, parameterId, value);
    if (!result.ok) {
      announce(`"${parameterId}" was refused: ${result.diagnostics[0].message}`);
      return;
    }
    chainUi.strip.syncHistory();
    const engine = getEngine();
    const module = getModule();
    if (!engine || !module) return;
    const definitions = engine.getParameterDefinitions();
    const name = engineControlName(parameterId, definitions);
    const refusal = name === null ? null
      : writeEngineValue(engine, module, definitions, name, value);
    if (refusal) {
      announce(refusal);
      return;
    }
    invalidate();
  };

  /**
   * Builds the pipeline strip and the stage library over one document store,
   * wiring every structural edit, undo and bypass toggle back through the one
   * apply path. The stages' parameters render on the strip's chips, so the
   * effect GUI panel is told to build none of them.
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
        const dropped = syncParity();
        applyPreset(active?.presetId ?? presetSelect.value);
        if (dropped) {
          show('The edit changed the descriptor: the preview is back on the '
            + 'interpreter and the parity toggle is disarmed.');
        }
        refreshLibraryLegality();
      },
      presetId: () => active?.presetId ?? null,
      onEditParameter: writeStageEdit,
    }));
    const library = createChainLibrary({
      doc,
      container: libraryMount,
      catalog: operatorCatalog,
      drag: strip.drag,
      announce,
      onPick: (/** @type {string} */ operatorId) => strip.insertOperator(operatorId),
    });
    setParamFilter({ external: true });
    chainUi = { store, strip, library };
    refreshLibraryLegality();
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
    // Every load previews through the interpreter, so a shipped pattern opens
    // as editable as a scratch chain; a digest match only arms the toolbar's
    // parity toggle to the promoted build.
    const official = [...catalog.values()].find((candidate) =>
      candidate.descriptorDigest === compiled.descriptor_digest) ?? null;
    teardownChainUi();
    if (!selectEffect(CHAIN_EFFECT)) {
      show(`The preview engine rejected effect "${CHAIN_EFFECT}".`, true);
      return false;
    }
    active = {
      compiled,
      filename,
      official,
      loadedDigest: compiled.descriptor_digest,
      compiledSide: false,
      presetId: null,
      referencePresetIds: official?.presetIds ?? [],
    };
    populatePresets(compiled);
    saveButton.disabled = false;
    if (saveAsButton) saveAsButton.disabled = false;
    showDigest();
    if (stripMount && libraryMount
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
    syncParity();
    const presetId = compiled.document.preset_bank.presets[0]?.preset_id;
    if (!presetId) {
      show('The document is valid, but it carries no preset to preview.', true);
      return false;
    }
    return applyPreset(presetId);
  };

  /**
   * The document as it stands: the store's once the editor is live, else the
   * load-time compile. Every edit is already a document edit, so nothing is
   * harvested back out of the engine.
   * @returns {*} An isolated copy.
   */
  const currentDocument = () => chainUi
    ? chainUi.store.document()
    : structuredClone(active.compiled.document);

  /**
   * @param {*} document - The document to write.
   * @param {string} filename - The download name.
   * @returns {boolean} Always true; a valid-by-construction document has no
   *   export failure state.
   */
  const exportDocument = (document, filename) => {
    download(filename, compiler.exportShaderDocumentJson(document));
    show(`Saved ${filename}.`);
    return true;
  };

  const save = () => {
    if (!active) return false;
    const document = currentDocument();
    return exportDocument(document, active.filename.endsWith('.shader.json')
      ? active.filename : `${document.effect_id}.shader.json`);
  };

  /**
   * Writes a copy under a fresh document id. The loaded document keeps its own
   * id and download name, so a following Save still re-exports the original.
   * @returns {boolean} Whether a document was written.
   */
  const saveAs = () => {
    if (!active) return false;
    const document = currentDocument();
    copies += 1;
    document.document_id = `${document.document_id}-copy${copies}`;
    return exportDocument(document, `${document.document_id}.shader.json`);
  };

  /**
   * Opens the default chain on catalog defaults through the ordinary load path,
   * so an unnamed session authors against the same strip and library a loaded
   * document gets.
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
    // A shared link naming a shipped document opens on that document; anything
    // else, the legacy Shader route included, opens on the scratch chain.
    const requested = catalog.get(initialEffect ?? '');
    if (requested === undefined) return loadScratch();
    sourceSelect.value = requested.effectId;
    return loadSource(requested.source, requested.filename, requested.compiled);
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
    chainUi?.strip.render();
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
  saveAsButton?.addEventListener('click', saveAs);
  // A/B verification only: the toggle swaps which build renders the loaded
  // document and touches neither the document nor the editing surface.
  parityToggle?.addEventListener('click', () => {
    if (active === null || !parityArmed()) return;
    const compiledSide = !active.compiledSide;
    const effect = compiledSide ? active.official.effectId : CHAIN_EFFECT;
    if (!selectEffect(effect)) {
      announce(`The preview engine rejected effect "${effect}".`);
      return;
    }
    active.compiledSide = compiledSide;
    syncParity();
    applyPreset(active.presetId ?? presetSelect.value);
  });
  digestButton?.addEventListener('click', async () => {
    const digest = digestButton.dataset.digest;
    if (!digest) return;
    if (await copyToClipboard(digest)) show(`Copied the descriptor digest ${digest}.`);
    else announce('The descriptor digest could not be copied.');
  });

  return { init, loadSource, save, saveAs, applyPreset };
}
