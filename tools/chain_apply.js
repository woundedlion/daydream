// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {{name: string, value?: *, readonly?: boolean, options?: string[]}} ParameterDefinition */
/** @typedef {{document: *, descriptor_digest?: string}} CompiledDocument */

/** @param {*} module @param {*} result */
const paramSetResultName = (module, result) =>
  Object.keys(module.ParamSetResult)
    .find((name) => module.ParamSetResult[name] === result) ?? 'unrecognized result';

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
 * as the option index that snapshot resolves them to.
 *
 * A session bypass compiles a program shape that omits document entries; the
 * omitted instances register no engine parameters, so their preset values are
 * skipped rather than refused — the document still carries them, which is what
 * keeps a bypass an A/B toggle instead of a document edit.
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
  for (const [parameterId, value] of Object.entries(preset?.values ?? {})) {
    const dot = parameterId.indexOf('.');
    if (dot > 0 && bypassed.has(parameterId.slice(0, dot))) continue;
    const definition = definitions.find(
      (candidate) => candidate.name === parameterId);
    if (!definition) return `the chain registered no parameter "${parameterId}"`;
    let stored = value;
    if (typeof value === 'string') {
      const index = definition.options?.indexOf(value) ?? -1;
      if (index < 0) return `"${parameterId}" has no option "${value}"`;
      stored = index;
    }
    const written = engine.setParameter(parameterId, stored);
    if (written !== module.ParamSetResult.APPLIED)
      return `"${parameterId}" was refused: ${paramSetResultName(module, written)}`;
  }

  syncEffectGui();
  invalidate();
  return null;
}
