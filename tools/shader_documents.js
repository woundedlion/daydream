const MIGRATION_URL = '../shader/patterns/shaderball_migration.json';
const COMPILER_URL = '../shader/shader_workbench.mjs';

/** @typedef {{name: string, value?: *, readonly?: boolean, options?: string[]}} ParameterDefinition */
/** @typedef {{document: *, descriptor_digest?: string, diagnostics?: *, status?: string}} CompiledDocument */

const STRUCTURAL_OPTIONS = Object.freeze({
  Function: Object.freeze({
    'twin-wave': 'Twin Wave',
    grid: 'Grid',
    'primitive-lattice': 'Primitive Lattice',
  }),
  Projection: Object.freeze({
    'folded-sinusoidal': 'Folded Sinusoidal',
    stereographic: 'Stereographic',
    'gnomonic-folded': 'Gnomonic',
    equirectangular: 'Equirectangular',
  }),
  'Surface Noise': Object.freeze({
    identity: 'None',
    'curl-noise-simplex-euler': 'Curl',
  }),
  Lens: Object.freeze({
    identity: 'None',
    glitch: 'Glitch',
    kaleidoscope: 'Kaleidoscope (Azimuthal 6-fold)',
    mobius: 'Mobius',
    'dodecahedral-kaleidoscope': 'Kaleidoscope (Dodecahedral / Icosahedral)',
    'triangular-prism-kaleidoscope': 'Kaleidoscope (Triangular Prism)',
    'hexagonal-prism-kaleidoscope': 'Kaleidoscope (Hexagonal Prism)',
  }),
  'Planar Warp 1': Object.freeze({
    identity: 'None',
    'affine-frame': 'Affine Frame',
    'wave-shear': 'Wave Shear',
    'vector-noise-simplex': 'Projected Vector Noise',
    'mirror-tile': 'Mirror Tile',
    'polar-chart-linear': 'Polar Chart',
  }),
  'Planar Warp 2': Object.freeze({
    identity: 'None',
    'affine-frame': 'Affine Frame',
    'wave-shear': 'Wave Shear',
    'vector-noise-simplex': 'Projected Vector Noise',
    'mirror-tile': 'Mirror Tile',
    'polar-chart-linear': 'Polar Chart',
  }),
  'Signal Weight': Object.freeze({ projection: 'Projection' }),
  'Value Transfer': Object.freeze({ linear: 'Linear', 'iso-contour': 'Iso Contour' }),
  Coverage: Object.freeze({
    opaque: 'Opaque',
    projection: 'Projection Weight',
    'projection-squared': 'Projection Weight Squared',
    'edge-fade': 'Edge Fade',
  }),
  Palette: Object.freeze({
    'generated-palette': 'Generated Triadic',
    generated_palette: 'Generated Triadic',
  }),
  'Hue Shift Mode': Object.freeze({
    noise: 'Noise',
    'path-length': 'Total Warp Displacement',
  }),
  'Brightness Envelope': Object.freeze({ none: 'None', cup: 'Cup' }),
});

/** @param {string} value */
function titleWords(value) {
  return value.split('-').map((part) => part.length === 0
    ? part : part[0].toUpperCase() + part.slice(1)).join(' ');
}

/** Maps a document parameter identity to its engine control. @param {string} parameterId */
export function engineParameterName(parameterId) {
  const warp = parameterId.match(/^(outer|inner)-(.+)$/u);
  if (warp) {
    const slot = warp[1] === 'outer' ? 1 : 2;
    return `Planar Warp ${slot} ${titleWords(warp[2])}`;
  }
  const aliases = /** @type {Record<string, string>} */ ({
    'edge-width': 'Edge Fade Width',
    'iso-level': 'Iso Contour Level',
    'iso-width': 'Iso Contour Width',
    'source-angle-speed': 'Source Angle Speed',
    'source-noise-scale': 'Source Noise Scale',
    'source-noise-contrast': 'Source Noise Contrast',
    'source-noise-speed': 'Source Noise Speed',
  });
  return aliases[parameterId] ?? titleWords(parameterId);
}

/** @param {string} parameterId */
function engineParameterNames(parameterId) {
  const primary = engineParameterName(parameterId);
  const fixedAliases = /** @type {Record<string, string[]>} */ ({
    'edge-width': ['Edge Width'],
    'iso-level': ['Iso Level'],
    'iso-width': ['Iso Width'],
    'mirror-speed': ['Planar Warp 2 Speed'],
    'mirror-rotation': ['Planar Warp 2 Rotation', 'Mirror Rotation'],
    'mirror-cell-x': ['Planar Warp 2 Cell X', 'Mirror Cell X'],
    'mirror-cell-y': ['Planar Warp 2 Cell Y', 'Mirror Cell Y'],
    'mirror-offset-x': ['Planar Warp 2 Offset X', 'Mirror Offset X'],
    'mirror-offset-y': ['Planar Warp 2 Offset Y', 'Mirror Offset Y'],
  });
  if (fixedAliases[parameterId]) return [primary, ...fixedAliases[parameterId]];
  const warp = parameterId.match(/^(outer|inner)-(.+)$/u);
  if (!warp) return [primary];
  const suffix = titleWords(warp[2]);
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

/** @param {ParameterDefinition} definition @param {*} label */
function optionIndex(definition, label) {
  const wanted = String(label).toLowerCase();
  return definition.options?.findIndex((option) => option.toLowerCase() === wanted) ?? -1;
}

/** @param {*} engine @param {ParameterDefinition[]} definitions @param {string} name @param {*} value */
function writeEngineValue(engine, definitions, name, value) {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition || definition.readonly) return false;
  let stored = value;
  if (definition.options) {
    if (typeof value !== 'number') {
      const label = name === 'Palette Mapping' ? titleWords(String(value)) : value;
      stored = optionIndex(definition, label);
      if (stored < 0) return false;
    }
  }
  return engine.setParameter(name, stored) !== false;
}

/** @param {*} engine @param {CompiledDocument} compiled @param {string} presetId */
function applyDocumentValues(engine, compiled, presetId) {
  const preset = compiled.document.preset_bank.presets
    .find((/** @type {*} */ candidate) => candidate.preset_id === presetId)
    ?? compiled.document.preset_bank.presets[0];
  const definitions = engine.getParameterDefinitions();
  for (const [parameterId, value] of Object.entries(preset?.values ?? {})) {
    const name = engineParameterNames(parameterId)
      .find((candidate) => definitions.some(
        (/** @type {ParameterDefinition} */ definition) => definition.name === candidate));
    if (!name || !writeEngineValue(engine, definitions, name, value)) return false;
  }
  return true;
}

/** Applies one authored preset to a matching concrete fixed-pipeline effect. */
export function applyFixedShaderDocument(engine, compiled, presetId,
                                         referencePresetIds) {
  const referenceId = referencePresetIds.includes(presetId)
    ? presetId : referencePresetIds[0];
  return typeof referenceId === 'string'
    && engine.selectPresetById?.(referenceId) === true
    && applyDocumentValues(engine, compiled, presetId);
}

/** Applies a linear six-role document to the dynamic Shader evaluator. */
/** @param {*} engine @param {CompiledDocument} compiled @param {string} presetId */
export function applyDynamicShaderDocument(engine, compiled, presetId) {
  const nodes = new Map(compiled.document.descriptor.graph.nodes
    .map((/** @type {*} */ node) => [node.role, node]));
  const surface = nodes.get('surface_project')?.policy ?? {};
  const warp = nodes.get('planar_warp')?.policy?.sequence ?? ['identity', 'identity'];
  const material = nodes.get('material')?.policy ?? {};
  const color = nodes.get('color')?.policy ?? {};
  const source = nodes.get('source')?.policy ?? {};
  const requested = {
    Function: source.source,
    Projection: surface.projection,
    'Surface Noise': surface.pre_lens_surface,
    Lens: surface.lens,
    'Planar Warp 1': warp[0],
    'Planar Warp 2': warp[1],
    'Signal Weight': material.weight,
    'Value Transfer': material.transfer,
    Coverage: material.coverage,
    Palette: color.color,
    'Hue Shift Mode': color.hue_mode,
    'Brightness Envelope': color.brightness_envelope,
  };
  for (const [name, policy] of Object.entries(requested)) {
    const options = /** @type {Record<string, string>|undefined} */ (
      /** @type {Record<string, *>} */ (STRUCTURAL_OPTIONS)[name]);
    const label = options?.[policy];
    if (!label) continue;
    const definitions = engine.getParameterDefinitions();
    if (!writeEngineValue(engine, definitions, name, label)) return false;
  }
  return applyDocumentValues(engine, compiled, presetId);
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
  URL.revokeObjectURL(url);
}

/** Owns document import, validation, preview selection, and export UI. */
/**
 * @param {{doc: Document, getEngine: () => *, selectEffect: (effect: string) => boolean,
 * syncEffectGui: () => void, invalidate: () => void,
 * fetchText?: (url: string) => Promise<string>, importCompiler?: () => Promise<*>,
 * download?: (filename: string, source: string) => void}} dependencies
 */
export function createShaderDocumentController({
  doc,
  getEngine,
  selectEffect,
  syncEffectGui,
  invalidate,
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

  /** @type {*} */
  let compiler;
  /** @type {*|null} */
  let active = null;
  /** @type {Map<string, *>} */
  let catalog = new Map();

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
    if (!engine || !active) return false;
    let applied;
    if (active.fixed) {
      applied = applyFixedShaderDocument(
        engine, active.compiled, presetId, active.referencePresetIds);
    } else applied = applyDynamicShaderDocument(engine, active.compiled, presetId);
    if (!applied) return false;
    syncEffectGui();
    invalidate();
    active.presetId = presetId;
    show(`${active.compiled.document.effect_metadata.display_name} · ${presetSelect.selectedOptions[0]?.textContent ?? presetId}`);
    return true;
  };

  /** @param {string} source @param {string} [filename] */
  const loadSource = async (source, filename = 'import.shader.json') => {
    compiler ??= await importCompiler();
    const compiled = compiler.compileShaderDocument(source);
    if (compiled.status !== 'VALID') {
      show(diagnosticText(compiled), true);
      return false;
    }
    const official = [...catalog.values()].find((candidate) =>
      candidate.descriptorDigest === compiled.descriptor_digest);
    const fixed = Boolean(official);
    const effect = official?.effectId ?? 'Shader';
    if (!selectEffect(effect)) {
      show(`The preview engine rejected effect "${effect}".`, true);
      return false;
    }
    active = {
      compiled,
      filename,
      fixed,
      presetId: null,
      referencePresetIds: official?.presetIds ?? [],
    };
    populatePresets(compiled);
    saveButton.disabled = false;
    const presetId = compiled.document.preset_bank.presets[0]?.preset_id;
    if (!presetId || !applyPreset(presetId)) {
      show('The document is valid, but its preview could not be applied.', true);
      return false;
    }
    return true;
  };

  const save = () => {
    if (!active) return false;
    const document = structuredClone(active.compiled.document);
    const preset = document.preset_bank.presets
      .find((/** @type {*} */ candidate) => candidate.preset_id === active.presetId);
    if (preset) {
      const definitions = getEngine()?.getParameterDefinitions?.() ?? [];
      for (const parameterId of Object.keys(preset.values)) {
        const names = engineParameterNames(parameterId);
        const definition = definitions.find(
          (/** @type {ParameterDefinition} */ candidate) => names.includes(candidate.name));
        if (!definition) continue;
        if (definition.options && parameterId === 'palette-mapping') {
          preset.values[parameterId] = definition.options[definition.value]?.toLowerCase();
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
      const migration = JSON.parse(await fetchText(MIGRATION_URL));
      const entries = await Promise.all(Object.entries(migration.source_documents)
        .map(async ([effectId, filename]) => {
          const source = await fetchText(`../shader/patterns/${filename}`);
          const compiled = compiler.compileShaderDocument(source);
          if (compiled.status !== 'VALID')
            throw new Error(`${filename}: ${diagnosticText(compiled)}`);
          return [effectId, filename, source, compiled];
        }));
      catalog = new Map(entries.map(([effectId, filename, source, compiled]) =>
        [effectId, {
          effectId,
          filename,
          source,
          descriptorDigest: compiled.descriptor_digest,
          presetIds: compiled.document.preset_bank.presets.map(
            (/** @type {*} */ preset) => preset.preset_id),
        }]));
      for (const [effectId, filename, source] of entries) {
        const option = doc.createElement('option');
        option.value = effectId;
        option.textContent = migration.product_group.children
          .find((/** @type {*} */ child) => child.effect_id === effectId)?.display_name
          ?? effectId;
        option.dataset.filename = filename;
        option.dataset.source = source;
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
      selectEffect('Shader');
      active = null;
      presetSelect.replaceChildren();
      presetSelect.disabled = true;
      saveButton.disabled = true;
      show('Scratch Shader is active.');
      return;
    }
    await loadSource(option.dataset.source ?? '', option.dataset.filename);
  });
  presetSelect.addEventListener('change', () => {
    if (!applyPreset(presetSelect.value))
      show(`Preset "${presetSelect.value}" could not be applied.`, true);
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
