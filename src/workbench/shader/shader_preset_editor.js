// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createPresetRail} from './chain_preset_rail.js';
import {createPresetTransport} from './chain_preset_transport.js';
import {labelOf} from './chain_presentation.js';
import {writeChainParameters} from './chain_apply.js';
import {enumConstantName} from '../../effects/param_sync.js';

/** @typedef {import('./chain_preset_bank.js').Edge} Edge */
/** @typedef {import('./chain_preset_rail.js').PromotionIssue} PromotionIssue */

/** @param {{
 * state: import('./shader_document_state.js').DocumentControllerState,
 * doc: Document, mount: HTMLElement|null,
 * getEngine: () => *, getModule: () => *, definitions: () => import('./chain_apply.js').ParameterDefinition[],
 * adopt: (id: string) => void, snap: (id: string) => boolean, choose: (id: string) => void,
 * onEdit: (result: import('./chain_document_store.js').EditResult, id?: string) => void,
 * toInterpreter: () => boolean, announce: (message: string) => void, requestFrame: () => void
 * }} deps */
export function createShaderPresetEditor({state, doc, mount, getEngine, getModule,
  definitions, adopt, snap, choose, onEdit, toInterpreter, announce, requestFrame}) {
  const store = () => state.chainUi?.store ?? null;
  const preset = () => state.active?.presetId ?? null;
  /** @type {Record<string, *>} */
  let liveValues = {};
  /** @type {Record<string, import('./chain_param_rows.js').EnumPreview>|null} */
  let liveEnums = null;

  const transport = createPresetTransport({
    bank: () => store()?.presetBankView() ?? null, preset, snap, adopt,
    start(edge) {
      if (state.active?.compiledSide !== true) return true;
      const order = store()?.presetBankView().choreography.generated_order;
      if (order && getEngine()?.startPresetTransition?.(order.indexOf(edge.from), order.indexOf(edge.to)) === true)
        return true;
      announce('The compiled effect refused this transition.');
      return false;
    },
    evaluate(edge, frame, seek) {
      const current = store();
      if (!current || !state.active) return false;
      if (seek && state.active.compiledSide && !toInterpreter()) return false;
      const document = current.compile().document;
      const {values, sourceMorph, modulationMorphs, paletteMorph} = state.compiler.evaluateTransition(document.descriptor, document.preset_bank,
        edge.from, edge.to, frame, state.operatorCatalog);
      if (!state.active.compiledSide) {
        const engine = getEngine();
        const module = getModule();
        if (!engine || !module) return false;
        const bypassed = new Set(current.bypassedLabels());
        const entries = Object.entries(values).filter(([id]) => !bypassed.has(labelOf(id)));
        const written = writeChainParameters(engine, module, definitions(), entries, {
          transition: true,
          sourceMorph: sourceMorph && !bypassed.has(sourceMorph.instance) ? sourceMorph : undefined,
          modulationMorphs: modulationMorphs?.filter(
            (/** @type {import('../../../generated/shader/shader_workbench.mjs').ModulationMorph} */ layer) =>
              !bypassed.has(layer.instance)),
          paletteMorph: paletteMorph && !bypassed.has(paletteMorph.instance) ? paletteMorph : undefined,
          seek,
        });
        if (written.refusal !== null || written.code !== null) {
          announce(written.refusal ?? ('The engine refused this frame (' + enumConstantName(module.ParamSetResult, written.code) + ').'));
          return false;
        }
      }
      const sourceValues = current.presetValuesView(edge.from);
      const targetValues = current.presetValuesView(edge.to);
      liveEnums = {};
      liveValues = {};
      for (const [id, value] of Object.entries(values)) {
        if (value !== null && typeof value === 'object') {
          const blend = /** @type {Required<import('./chain_param_rows.js').EnumPreview>} */ (value);
          liveEnums[id] = blend;
          liveValues[id] = blend.mix < 1 ? blend.from : blend.to;
        } else {
          liveValues[id] = value;
          if (typeof value === 'string' && typeof sourceValues?.[id] === 'string' && typeof targetValues?.[id] === 'string')
            liveEnums[id] = {from: sourceValues[id], to: targetValues[id]};
        }
      }
      return true;
    },
    update(preview) {
      const current = store();
      const id = preset();
      if (preview) state.chainUi?.strip.showTransitionValues(liveValues, liveEnums, preview.playing);
      else state.chainUi?.strip.showTransitionValues(id === null ? {} : current?.presetValuesView(id) ?? {}, null, false);
      rail?.sync();
    },
    requestFrame,
  });

  /** @param {Edge} _edge @param {*} from @param {*} to */
  function latticeAllowsEdge(_edge, from, to) {
    const check = getModule()?.ShaderChainBindings?.admitsPlanarSourceTransition;
    if (typeof check !== 'function') return true;
    const binding = getModule().ShaderChainBindings;
    const program = store()?.chainView().map(({label, operator}) => ({instance: label, operator}));
    const parameters = store()?.parameterDeclarations();
    if (!program || !parameters) return true;
    const parameterById = new Map(parameters.map((parameter) => [parameter.id, parameter]));
    /** @param {Record<string, *>} values */
    const encode = (values) => Object.fromEntries(Object.entries(values)
      .filter(([id]) => program.some((slot) => slot.instance === labelOf(id)))
      .map(([id, value]) => [id, typeof value === 'string' ? parameterById.get(id)?.domain?.values?.indexOf(value) : value]));
    return check.call(binding, program, encode(from.values), encode(to.values)) === true;
  }

  /** @param {PromotionIssue} issue */
  function jump(issue) {
    if (issue.preset_id) choose(issue.preset_id);
    if (issue.parameter_id) {
      state.chainUi?.strip.focusParameter(issue.parameter_id);
      return;
    }
    if (issue.from && issue.to) {
      const edge = [...(mount?.querySelectorAll('details.shader-preset-edge') ?? [])]
        .find((element) => element.getAttribute('data-from') === issue.from
          && element.getAttribute('data-to') === issue.to);
      if (edge) {
        /** @type {HTMLDetailsElement} */ (edge).open = true;
        /** @type {HTMLElement|null} */ (edge.querySelector('summary'))?.focus();
        return;
      }
      const offRail = /** @type {HTMLElement|undefined} */ ([...(mount?.querySelectorAll('[data-offrail]') ?? [])]
        .find((element) => element.getAttribute('data-from') === issue.from
          && element.getAttribute('data-to') === issue.to));
      if (offRail) {
        offRail.focus();
        return;
      }
    }
    doc.getElementById('shader-preset-dwell')?.focus();
  }

  const rail = mount ? createPresetRail({doc, mount, store, preset, choose, edit: onEdit,
    transport, catalog: () => state.operatorCatalog,
    diagnostics: () => state.compiler.promotionDiagnostics?.(store()?.document(), {
      catalog: state.operatorCatalog,
      authoredTopology: state.active?.official?.authoredTopology === true,
      authoredPalette: state.active?.official?.authoredPalette === true,
      latticeAllowsEdge,
    }) ?? [], jump,
  }) : null;

  return {
    transport,
    stopPreviewForEdit: () => { if (transport.inProgress()) transport.stop(); },
    render: () => rail?.render(),
    reset: transport.clear,
  };
}
