/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {enumConstantName, replayParameterWrites} from '../../effects/param_sync.js';
import {fieldOf as fieldSegment, labelOf, MODULATION_OPERATOR, modulationValueLimits} from './chain_presentation.js';
import {resolveParameterWrite, writeChainParameters} from './chain_apply.js';
import {BAKED_CONSTANT_IDS, documentModulationBinding, promotedControlNames} from '../../../generated/shader/shader_workbench.mjs';
import {errorDetail} from '../../shared/banner.js';
/** @typedef {import('./chain_apply.js').ParameterDefinition} ParameterDefinition */
/** @typedef {import('./chain_apply.js').CompiledDocument} CompiledDocument */

/** @param {*} expected @param {*} actual @returns {boolean} Float32 snapshot equality. */
export function snapshotValueEqual(expected, actual) {
  if (typeof expected === 'number' && typeof actual === 'number')
    return Math.fround(expected) === Math.fround(actual);
  if (expected === null || actual === null || typeof expected !== 'object'
      || typeof actual !== 'object') return expected === actual;
  if (Array.isArray(expected) !== Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length
    && keys.every((key) => Object.hasOwn(actual, key) && snapshotValueEqual(expected[key], actual[key]));
}

/**
 * @param {string} parameterId
 * @param {ParameterDefinition[]} definitions
 * @param {Set<string>} baked
 * @param {*} descriptor
 * @param {*} catalog
 * @returns {{name: string|null, refusal: string|null}} Compiled control or refusal.
 */
export function compiledControlFor(parameterId, definitions, baked, descriptor, catalog = null) {
  const name = promotedControlNames(parameterId, descriptor, catalog)
    .find((candidate) => definitions.some((definition) =>
      definition.name === candidate && !definition.readonly));
  if (name) return { name, refusal: null };
  if (BAKED_CONSTANT_IDS.has(parameterId) || baked.has(fieldSegment(parameterId)))
    return { name: null, refusal: null };
  return { name: null, refusal: `no engine parameter matches "${parameterId}"` };
}

/**
 * @param {string} id @param {*} control @param {ParameterDefinition[]} definitions
 * @param {{unregistered?: true}} binding - An `unregistered` binding is live wherever a control resolves.
 */
function liveDerivedControl(id, control, definitions, binding) {
  if (control.name === null) return false;
  if (binding.unregistered) return true;
  const label = labelOf(id);
  const resource = control.name.slice(0, control.name.lastIndexOf('.'));
  return control.name === fieldSegment(id) || control.name.endsWith('.' + fieldSegment(id))
    || definitions.some((definition) => !definition.readonly
      && [label + '.modulation-source', resource + '.modulation-source', 'modulation-source',
        label + '.coverage-mode', resource + '.coverage-mode', 'coverage-mode']
        .includes(definition.name));
}

/** @param {*} engine @param {*} module @param {Array<{name: string, stored: number}>} writes */
function performEngineWrites(engine, module, writes) {
  const rejected = replayParameterWrites(writes.map(({name, stored}) => ({name, value: stored})),
    (name, value) => engine.setParameter(name, value), module.ParamSetResult);
  const refusal = rejected[0];
  return refusal ? `"${refusal.name}" was refused: ${enumConstantName(module.ParamSetResult, refusal.result)}` : null;
}

/** @param {*} descriptor @param {string} parameterId @param {*[]} definitions */
export function documentControlFor(descriptor, parameterId, definitions) {
  const binding = documentModulationBinding(descriptor, parameterId);
  return binding && definitions.find((definition) => definition.resource === binding.resource
    && definition.id === binding.id);
}

/** @param {*} definition @param {*} value @returns {*|string|null} */
function resolveDocumentWrite(definition, value) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return `"${definition.id}" has no numeric value`;
  if (definition.readonly) return snapshotValueEqual(value, definition.value)
    ? null : `"${definition.id}" must match the fixed build's value ${definition.value}`;
  return {resource: definition.resource, id: definition.id, stored: value};
}

/** @param {*} engine @param {*} module @param {*[]} writes @returns {string|null} */
function performDocumentWrites(engine, module, writes) {
  for (const {resource, id, stored} of writes) {
    const result = engine.setDocumentParameter(resource, id, stored);
    if (result !== module.ParamSetResult.APPLIED)
      return `"${resource}.${id}" was refused: ${enumConstantName(module.ParamSetResult, result)}`;
  }
  return null;
}

/**
 * Resolves fixed-build values before any engine or document write is performed.
 * @param {Record<string, *>} values
 * @param {ParameterDefinition[]} definitions
 * @param {*[]} documentDefinitions
 * @param {*} descriptor
 * @param {(id: string) => {name: string|null, refusal: string|null}} resolveControl
 * @param {(id: string, control: {name: string|null, refusal: string|null}) => boolean} skip
 * @returns {{writes: Array<{name: string, stored: *}>, documentWrites: *[], refusal: string|null}}
 */
function resolveFixedWrites(values, definitions, documentDefinitions, descriptor, resolveControl, skip) {
  const writes = [];
  const documentWrites = [];
  for (const [id, value] of Object.entries(values)) {
    const control = resolveControl(id);
    if (skip(id, control)) continue;
    if (control.refusal) {
      const definition = documentControlFor(descriptor, id, documentDefinitions);
      if (!definition) return {writes, documentWrites, refusal: control.refusal};
      const write = resolveDocumentWrite(definition, value);
      if (typeof write === 'string') return {writes, documentWrites, refusal: write};
      if (write) documentWrites.push(write);
    } else if (control.name !== null) {
      const write = resolveParameterWrite(definitions, control.name, value);
      if (typeof write === 'string') return {writes, documentWrites, refusal: write};
      writes.push(write);
    }
  }
  return {writes, documentWrites, refusal: null};
}

/**
 * @param {import('../../../generated/holosphere_wasm.js').HolosphereEngine} engine @param {import('../../../generated/holosphere_wasm.js').HolosphereModule} module @param {CompiledDocument} compiled
 * @param {Record<string, *>} values - Values from the selected document preset.
 * @param {Set<string>} baked - The topology fields the effect bakes in.
 * @param {Set<string>} derived - Validated fields computed by the fixed effect.
 * @param {*} catalog
 * @returns {string|null} Refusal reason, or null once every writable value is written.
 *   Baked and derived values are skipped; an unregistered id refuses before any write.
 */
function applyDocumentValues(engine, module, compiled, values, baked, derived, catalog) {
  const definitions = engine.getParameterDefinitions();
  const resolved = resolveFixedWrites(values, definitions,
    engine.getDocumentParameterDefinitions?.() ?? [], compiled.document.descriptor,
    (id) => compiledControlFor(id, definitions, baked, compiled.document.descriptor, catalog),
    (id) => derived.has(id));
  return resolved.refusal ?? performEngineWrites(engine, module, resolved.writes)
    ?? performDocumentWrites(engine, module, resolved.documentWrites);
}

/**
 * Applies one authored preset to a matching concrete fixed-pipeline effect.
 * @param {import('../../../generated/holosphere_wasm.js').HolosphereEngine} engine
 * @param {import('../../../generated/holosphere_wasm.js').HolosphereModule} module
 * @param {CompiledDocument} compiled
 * @param {string} presetId
 * @param {string[]} referencePresetIds
 * @param {Set<string>} baked - The topology fields the effect bakes in.
 * @param {(descriptor: *, parameterId: string, values: *) => *} deriveBinding - Compiler binding resolver.
 * @param {*} [catalog] - Operator fields used by the native controls.
 * @returns {string|null} Refusal reason, or null once applied.
 */
export function applyFixedShaderDocument(engine, module, compiled, presetId,
  referencePresetIds, baked, deriveBinding, catalog = null) {
  const referenceId = referencePresetIds.includes(presetId)
    ? presetId : referencePresetIds[0];
  if (typeof referenceId !== 'string') return 'the effect has no reference preset';
  const preset = compiled.document.preset_bank.presets
    .find((/** @type {*} */ candidate) => candidate.preset_id === presetId);
  if (!preset) return `the document has no preset "${presetId}"`;
  const values = preset.values ?? {};
  const derived = new Set();
  const definitions = engine.getParameterDefinitions();
  for (const parameterId of Object.keys(values)) {
    const binding = deriveBinding(compiled.document.descriptor, parameterId, values);
    if (!binding) continue;
    const control = compiledControlFor(parameterId, definitions, baked, compiled.document.descriptor, catalog);
    if (liveDerivedControl(parameterId, control, definitions, binding)) continue;
    if (!binding.valid)
      return `"${parameterId}" must match the fixed build's derived value ${binding.expected}`;
    derived.add(parameterId);
  }
  if (engine.selectPresetById?.(referenceId) !== true)
    return `the engine refused reference preset "${referenceId}"`;
  return applyDocumentValues(engine, module, compiled, values, baked, derived, catalog);
}

/** Resolves coupled modulation edits into one preset write.
 * @param {string} parameterId Edited parameter id.
 * @param {*} value Edited value.
 * @param {*} descriptor Current chain descriptor.
 * @param {Readonly<Record<string, *>>} presetValues Current preset values.
 * @returns {Record<string, *>} Values to commit atomically. */
function stageEditValues(parameterId, value, descriptor, presetValues) {
  const values = { [parameterId]: value };
  const label = labelOf(parameterId);
  const field = fieldSegment(parameterId);
  const modulated = descriptor.chain.some((/** @type {*} */ entry) =>
    entry.label === label && entry.operator === MODULATION_OPERATOR);
  if (modulated) {
    const valueOf = (/** @type {string} */ field) => {
      const id = `${label}.${field}`;
      return values[id] ?? presetValues[id];
    };
    if (field === 'modulation-source' && value !== 'noise')
      values[`${label}.modulation-evaluation`] = 'direct';
    if (field === 'modulation-mechanic') {
      const limits = modulationValueLimits('modulation-amount', valueOf);
      if (limits) {
        const amount = Number(valueOf('modulation-amount') ?? 0);
        values[`${label}.modulation-amount`] = Math.max(limits.min, Math.min(limits.max, amount));
      }
    }
    if (field === 'modulation-evaluation') {
      const limits = modulationValueLimits('pattern-scale', valueOf);
      if (limits && Number(valueOf('pattern-scale') ?? 1) > limits.max)
        values[`${label}.pattern-scale`] = limits.max;
    }
  }
  return values;
}

/** Creates stage-edit admission and engine-write routing.
 * @param {{state: import('./shader_documents.js').DocumentControllerState,
 * parameterLive: (id: string) => boolean, getEngine: () => *, getModule: () => *,
 * getAnimationsPaused: () => boolean|null,
 * engineControlName: (id: string, definitions: ParameterDefinition[]) => {name: string|null, refusal: string|null},
 * restoreAnimationsPaused: (paused: boolean|null) => void, invalidate: () => void,
 * announce: (message: string) => void, syncParity: () => boolean,
 * applyPreset: (preset: string) => boolean, showParityDropStatus: () => void,
 * showPreviewStatus: () => void, status: HTMLOutputElement,
 * markHalted: (error: unknown) => void, showError: (message: string) => void}} dependencies */
export function createShaderStageEditor({state, parameterLive, getEngine, getModule,
  getAnimationsPaused, engineControlName, restoreAnimationsPaused, invalidate, announce,
  syncParity, applyPreset, showParityDropStatus, showPreviewStatus, status, markHalted, showError}) {
  /** @param {{parameterId: string, value: *, values: Record<string, *>, presetValues: Readonly<Record<string, *>>, descriptor: *, compiledSide: boolean, addsDeclaration: boolean, coupled: boolean}} edit
   * @returns {import('./chain_document_store.js').EditResult} */
  const admitStageValues = ({parameterId, value, values, presetValues, descriptor,
    compiledSide, addsDeclaration, coupled}) => {
    if (addsDeclaration && compiledSide) return { ok: true };
    const engine = getEngine();
    const module = getModule();
    if (!engine || !module) return { ok: true };
    const definitions = engine.getParameterDefinitions();
    const control = engineControlName(parameterId, definitions);
    const paused = getAnimationsPaused();
    let refusal = control.refusal;
    if (compiledSide || (refusal === null && control.name !== null)) {
      if (coupled && !compiledSide) {
        const written = writeChainParameters(engine, module, definitions, Object.entries(values));
        refusal = written.refusal;
        if (written.code !== null)
          refusal = `"${parameterId}" was refused: ${enumConstantName(module.ParamSetResult, written.code)}`;
      } else if (compiledSide) {
        state.cachedDocumentDefinitions = null;
        const resolved = resolveFixedWrites(values, definitions,
          engine.getDocumentParameterDefinitions?.() ?? [], descriptor,
          (id) => engineControlName(id, definitions),
          (id, control) => {
            const binding = state.compiler.fixedDerivedBinding?.(descriptor, id, {...presetValues, ...values});
            return Boolean(binding && !liveDerivedControl(id, control, definitions, binding));
          });
        refusal = resolved.refusal ?? performEngineWrites(engine, module, resolved.writes)
              ?? performDocumentWrites(engine, module, resolved.documentWrites);
      } else if (control.name !== null) {
        const write = resolveParameterWrite(definitions, control.name, value);
        refusal = typeof write === 'string' ? write : performEngineWrites(engine, module, [write]);
      }
    }
    restoreAnimationsPaused(paused);
    invalidate();
    return refusal ? { ok: false, diagnostics: [{
      severity: 'error', phase: 'apply', code: 'ENGINE_REFUSAL',
      path: parameterId, message: refusal,
    }] } : { ok: true };
  };

  /**
   * Routes an inline stage-control edit into the active preset: the document is
   * the source of truth and the engine write is its side effect.
   * @param {string} parameterId - The edited parameter's id.
   * @param {*} value - The document value: a number, or an enum8 option id.
   * @returns {boolean}
   */
  const writeStageEdit = (parameterId, value) => {
    if (!parameterLive(parameterId)) return false;
    try {
      if (state.chainUi === null || state.active === null || state.active.presetId === null) return false;
      const presetId = state.active.presetId;
      const compiledSide = state.active.compiledSide;
      const store = state.chainUi.store;
      const presetValues = store.presetValuesView(presetId);
      if (presetValues === null) return false;
      const descriptor = { chain: store.chainView() };
      const values = stageEditValues(parameterId, value, descriptor, presetValues);
      const addsDeclaration = Object.keys(values).some(id => !store.declares(id));
      const coupled = Object.keys(values).length > 1;
      const result = store.setPresetValues(presetId, values, () => admitStageValues({parameterId, value, values, presetValues, descriptor,
        compiledSide, addsDeclaration, coupled}));
      if (!result.ok) {
        const diagnostic = result.diagnostics[0];
        announce(diagnostic.code === 'ENGINE_REFUSAL' ? diagnostic.message
          : `"${parameterId}" was refused: ${diagnostic.message}`);
        return false;
      }
      state.linkWriter.releaseOriginalLink();
      let applied = true;
      if (addsDeclaration) {
        const dropped = syncParity();
        applied = applyPreset(state.active.presetId);
        if (dropped && applied) {
          state.rebuildAfterParameterCommit = true;
          showParityDropStatus();
        }
      }
      if (Object.keys(values).length > 1) state.chainUi.strip.syncParameterValues(values);
      state.chainUi.strip.syncHistory();
      if (applied && status.dataset.status === 'error') showPreviewStatus();
      state.linkWriter.schedule();
      return true;
    } catch (error) {
      markHalted(error);
      showError(`The preview edit failed: ${errorDetail(error)}`);
      return false;
    }
  };
  return {writeStageEdit};
}
