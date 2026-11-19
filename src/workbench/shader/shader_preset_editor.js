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
 * toInterpreter: () => boolean, announce: (message: string) => void, requestFrame: () => void,
 * writeParameter: (id: string, value: *, all?: boolean) => boolean
 * }} deps */
export function createShaderPresetEditor({state, doc, mount, getEngine, getModule,
  definitions, adopt, snap, choose, onEdit, toInterpreter, announce, requestFrame, writeParameter}) {
  const store = () => state.chainUi?.store ?? null;
  const preset = () => state.active?.presetId ?? null;
  /** @type {Set<string>} */
  const unlocked = new Set();
  /** @type {{id: string, all: boolean}|null} */
  let gesture = null;
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
      const {values, sourceMorph, modulationMorphs} = state.compiler.evaluateTransition(document.descriptor, document.preset_bank,
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

  /** @type {Readonly<import('./chain_preset_bank.js').Bank>|null} */
  let defaultsBank = null;
  /** @type {Map<string, *>} */
  let defaults = new Map();

  /** @param {string} id */
  function valuesFor(id) {
    const current = store();
    const active = preset();
    if (!current || active === null) return null;
    const bank = current.presetBankView();
    const {presets, choreography: {generated_order: order}} = bank;
    if (defaultsBank !== bank) {
      defaultsBank = bank;
      defaults = new Map(current.parameterDeclarations().map(({id, default: value}) => [id, value]));
    }
    const authored = current.presetValuesView(active);
    const fallback = defaults.get(id);
    const previous = order[(order.indexOf(active) + order.length - 1) % order.length];
    const value = authored?.[id] ?? fallback;
    const prior = current.presetValuesView(previous)?.[id] ?? fallback;
    const uniform = presets.every((preset) => (preset.values[id] ?? fallback) === value);
    return {value, prior, changed: prior !== value, uniform, unlocked: unlocked.has(id)};
  }

  /** @param {string} id @param {*} value @param {boolean} [all] */
  function editParameter(id, value, all) {
    if (transport.inProgress()) transport.stop();
    const status = valuesFor(id);
    const current = store();
    if (all !== undefined) {
      current?.endValueRun();
      const result = writeParameter(id, value, all);
      current?.endValueRun();
      gesture = null;
      if (result) {
        unlocked.delete(id);
        state.chainUi?.strip.syncParameterValues({[id]: value});
      }
      return result;
    }
    if (gesture?.id !== id)
      gesture = {id, all: status?.uniform === true && !status.unlocked};
    const result = writeParameter(id, value, gesture.all);
    if (result) unlocked.delete(id);
    else gesture = null;
    return result;
  }

  return {
    transport,
    editParameter,
    render: () => rail?.render(),
    endGesture: () => { gesture = null; },
    reset() { transport.clear(); unlocked.clear(); gesture = null; },
    rows: {
      status: valuesFor,
      beforeEdit: () => { if (transport.inProgress()) transport.stop(); },
      /** @param {string} id */
      lock(id) {
        const status = valuesFor(id);
        if (!status) return;
        if (status.uniform && !status.unlocked) unlocked.add(id);
        else if (status.uniform) unlocked.delete(id);
        else editParameter(id, status.value, true);
      },
      /** @param {string} id */
      applyAll: (id) => { const status = valuesFor(id); if (status) editParameter(id, status.value, true); },
      /** @param {string} id */
      copyPrevious: (id) => { const status = valuesFor(id); if (status) editParameter(id, status.prior, false); },
    },
  };
}
