// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { enumConstantName } from '../param_sync.js';

/** @typedef {{name: string, value?: *, readonly?: boolean, options?: string[]}} ParameterDefinition */
/** @typedef {{document: *, descriptor_digest?: string}} CompiledDocument */

/**
 * Applies a compiled chain document to the chain engine, in the one fixed
 * order: setShaderChain with the document's chain, the named preset's values
 * by parameter id, then the GUI resync and a repaint. The engine re-validates
 * the chain the document layer already validated, so a setShaderChain refusal
 * is a trust boundary, not UX: it is surfaced verbatim with its {code,
 * entryIndex} rather than translated.
 *
 * Every APPLIED setShaderChain bumps the engine's param generation and
 * rebuilds the parameter definitions, so the definitions are snapshot only
 * after the chain lands; enum8 values (topology fields included) are written
 * as the option index that snapshot resolves them to. Every value is resolved
 * against that snapshot before the first write, so a value the engine would
 * refuse aborts the apply with no value written at all.
 *
 * A session bypass compiles a program shape that omits document entries; the
 * omitted instances register no engine parameters, so their preset values are
 * skipped rather than refused — the document still carries them, which is what
 * keeps a bypass an A/B toggle instead of a document edit.
 *
 * A refusal from the write loop runs the resync and the repaint before it
 * returns: the earlier writes have landed, so the GUI and the frame have to
 * read the engine rather than the superseded preset.
 *
 * @param {{engine: *, module: *, compiled: CompiledDocument, presetId: string,
 *   syncEffectGui: () => void, invalidate: () => void,
 *   programShape?: Array<{instance: string, operator: string}>|null}} apply -
 *   programShape overrides the chain sent to the engine (the document chain
 *   minus the session-bypassed instances); omitted, the document chain is sent
 *   whole.
 * @returns {string|null} Refusal reason, or null once applied.
 */
export function applyChainDocument({
  engine, module, compiled, presetId, syncEffectGui, invalidate,
  programShape = null,
}) {
  const documentChain = /** @type {Array<{label: string, operator: string}>} */ (
    compiled.document.descriptor.chain);
  const chain = programShape
    ?? documentChain.map((entry) => ({ instance: entry.label, operator: entry.operator }));
  const live = new Set(chain.map((entry) => entry.instance));
  const bypassed = new Set(
    documentChain.map((entry) => entry.label).filter((label) => !live.has(label)));
  const result = engine.setShaderChain(chain);
  if (result?.code !== 'APPLIED') {
    const code = result?.code ?? 'no result';
    const at = typeof result?.entryIndex === 'number' && result.entryIndex >= 0
      ? ` at chain entry ${result.entryIndex}` : '';
    return `the engine refused the chain: ${code}${at}`;
  }

  const definitions = /** @type {ParameterDefinition[]} */ (
    engine.getParameterDefinitions());
  const presets = compiled.document.preset_bank.presets;
  const preset = presets.find(
    (/** @type {*} */ candidate) => candidate.preset_id === presetId)
    ?? presets[0];
  /** @type {Array<[string, number]>} */
  const writes = [];
  for (const [parameterId, value] of Object.entries(preset?.values ?? {})) {
    const dot = parameterId.indexOf('.');
    if (dot > 0 && bypassed.has(parameterId.slice(0, dot))) continue;
    const definition = definitions.find(
      (candidate) => candidate.name === parameterId);
    if (!definition) return `the chain registered no parameter "${parameterId}"`;
    if (definition.readonly) return `"${parameterId}" is read-only`;
    let stored = value;
    if (typeof value === 'string') {
      const index = definition.options?.indexOf(value) ?? -1;
      if (index < 0) return `"${parameterId}" has no option "${value}"`;
      stored = index;
    }
    if (typeof stored !== 'number' || !Number.isFinite(stored))
      return `"${parameterId}" has no numeric value`;
    writes.push([parameterId, stored]);
  }

  for (const [parameterId, stored] of writes) {
    const written = engine.setParameter(parameterId, stored);
    if (written === module.ParamSetResult.APPLIED) continue;
    syncEffectGui();
    invalidate();
    return `"${parameterId}" was refused: `
      + `${enumConstantName(module.ParamSetResult, written)}`;
  }

  syncEffectGui();
  invalidate();
  return null;
}
