/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */
import { movedOps } from './solid_op_order.js';
import { MAX_RECIPE_STEPS } from './solid_validation.js';
import { OP_DEFS, authoredParamRange, opTopologyKey, seedOpParams, snapToStep } from './solid_op_params.js';
import { buildOpRow, formatParamValue, syncSweepWarning } from './solid_op_rows.js';

/** Supplies operation and browser services. */
function defaultDependencies() {
  return { movedOps, document: globalThis.document, buildOpRow, OP_DEFS, syncSweepWarning, opTopologyKey, snapToStep, authoredParamRange, formatParamValue, structuredClone: globalThis.structuredClone.bind(globalThis), MAX_RECIPE_STEPS, seedOpParams, window: globalThis.window };
}

/** @param {import('./solids_state.js').SolidsPage} page
 * @param {import('./solids_state.js').SolidsActions} actions
 * @param {Partial<ReturnType<typeof defaultDependencies>>} [dependencies] */
export function createSolidsOpsController(page, actions, dependencies = {}) {
  const env = {...defaultDependencies(), ...dependencies};
  /** Wires operation-chain controls. @returns {void} */
  function wireOpControls() {
    (/** @type {HTMLElement} */ (env.document.getElementById('clearOpsBtn'))).addEventListener('click', actions.resetOps);
    (/** @type {HTMLElement} */ (env.document.getElementById('addOpGrid'))).addEventListener('click', actions.activateAddOp);
  }

  /** @param {number} from @param {number} to @param {number} revision @returns {void} */
  function reorderOp(from, to, revision) {
    if (revision !== page.doc.opsRevision) return;
    if (to < 0 || to >= page.doc.ops.length || from === to) return;
    const opName = page.doc.ops[from].op;
    actions.queueCommit(async () => {
      if (revision !== page.doc.opsRevision) return;
      const check = await actions.chainIsValid(page.doc.base, env.movedOps(page.doc.ops, from, to));
      if (!check.ok) {
        actions.showGateMsg(`rejected: ${check.message}`);
        return;
      }
      actions.setOps(env.movedOps(page.doc.ops, from, to));
      actions.renderOps();
      actions.showGateMsg('');
      actions.update();
      actions.showGateMsg(`moved ${opName} to position ${to + 1}`, { persist: false });
      const movedItem = (/** @type {HTMLElement} */ (env.document.getElementById('opsList'))).children[to];
      const direction = to > from ? '.move-op-down' : '.move-op-up';
      const preferred = (/** @type {HTMLButtonElement|null} */ (movedItem.querySelector(direction)));
      const focusTarget = preferred && !preferred.disabled ? preferred
        : [.../** @type {NodeListOf<HTMLButtonElement>} */ (movedItem.querySelectorAll('.move-op-btn'))].find(button => !button.disabled);
      focusTarget?.focus();
    });
  }

  /** @returns {void} */
  function renderOps() {
    const list = (/** @type {HTMLElement} */ (env.document.getElementById('opsList')));
    list.replaceChildren();

    const revision = page.doc.opsRevision;
    page.doc.ops.forEach((o, i) => {
      const el = env.buildOpRow(o, i, {
        opDef: env.OP_DEFS[o.op],
        count: page.doc.ops.length,
        on: {
          wireDrag: (grip, row) => actions.wireRowDrag(grip, i, row, list, revision),
          move: (from, to) => actions.reorderOp(from, to, revision),
          remove: (at) => actions.removeOp(at, revision),
          setParam: (index, key, value) => actions.updateOpParam(index, key, value, revision),
          explain: actions.showGateMsg,
        },
      });

      list.appendChild(el);
    });
  }

  /** @param {number} index @param {string} key @param {string} value @param {number} revision @returns {void} */
  function updateOpParam(index, key, value, revision) {
    if (revision !== page.doc.opsRevision || !page.doc.ops[index]) return;
    const def = env.OP_DEFS[page.doc.ops[index].op]?.params?.[key];
    let val = parseFloat(value);
    const invalidValue = Number.isNaN(val);
    if (invalidValue) {
      val = page.doc.ops[index].params[key];
    } else if (def) {
      val = val === page.doc.ops[index].params[key]
        ? val : env.snapToStep(val, env.authoredParamRange(def, page.doc.ops[index].params[key]));
    }
    const editKey = `${revision}:${index}:${key}`;
    const edit = Symbol();
    page.doc.parameterEdits.set(editKey, edit);
    const candidateOp = {
      op: page.doc.ops[index].op,
      params: { ...page.doc.ops[index].params, [key]: val },
    };

    const item = (/** @type {HTMLElement} */ (env.document.getElementById('opsList'))).children[index];
    const row = item && [.../** @type {NodeListOf<HTMLElement>} */ (item.querySelectorAll('.op-param'))].find(r => r.dataset.key === key);
    if (row) {
      const slider = (/** @type {HTMLInputElement|null} */ (row.querySelector('input[type="range"]')));
      const input = (/** @type {HTMLInputElement|null} */ (row.querySelector('input[type="number"]')));

      if (slider) slider.value = String(val);
      if (input) input.value = env.formatParamValue(val, def);
    }
    if (invalidValue) return;
    if (item) env.syncSweepWarning(/** @type {HTMLElement} */ (item), candidateOp);
    const focusType = row && row.contains(env.document.activeElement) ? (/** @type {HTMLInputElement} */ (env.document.activeElement)).type : null;

    if (env.opTopologyKey(page.doc.ops[index]) !== env.opTopologyKey(candidateOp)) {
      actions.scheduleUpdate.cancel();
      actions.queueCommit(async () => {
        if (revision !== page.doc.opsRevision || page.doc.parameterEdits.get(editKey) !== edit) return;
        const candidate = env.structuredClone(page.doc.ops);
        candidate[index].params[key] = val;
        const check = await actions.chainIsValid(page.doc.base, candidate);
        if (revision !== page.doc.opsRevision || page.doc.parameterEdits.get(editKey) !== edit) return;
        if (check.ok) {
          page.doc.ops[index].params[key] = val;
          actions.showGateMsg('');
          actions.update();
          return;
        }
        actions.showGateMsg(`rejected: ${check.message}`);
        actions.renderOps();
        if (focusType) {
          const restoredItem = (/** @type {HTMLElement} */ (env.document.getElementById('opsList'))).children[index];
          const restoredRow = [.../** @type {NodeListOf<HTMLElement>} */ (restoredItem.querySelectorAll('.op-param'))].find(r => r.dataset.key === key);
          (/** @type {HTMLInputElement|null|undefined} */ (restoredRow?.querySelector(`input[type="${focusType}"]`)))?.focus();
        }
        actions.update();
      });
      return;
    }
    page.doc.ops[index].params[key] = val;
    actions.scheduleUpdate();
  }

  /** @param {number} index @param {number} revision @returns {void} */
  function removeOp(index, revision) {
    actions.queueCommit(async () => {
      if (revision !== page.doc.opsRevision) return;
      const candidate = page.doc.ops.filter((op, i) => i !== index);
      const check = await actions.chainIsValid(page.doc.base, candidate);
      if (!check.ok) {
        actions.showGateMsg(`rejected: ${check.message}`);
        return;
      }
      actions.setOps(candidate);
      actions.renderOps();
      actions.showGateMsg('');
      actions.update();
      const rows = (/** @type {HTMLElement} */ (env.document.getElementById('opsList'))).children;
      (/** @type {HTMLElement|null|undefined} */ (rows[Math.min(index, rows.length - 1)]?.querySelector('.remove-op-btn')
        ?? env.document.querySelector('#addOpGrid [data-op]:not(:disabled)')))?.focus();
    });
  }

  /** @param {Event} event @returns {void} */
  function activateAddOp(event) {
    const button = /** @type {HTMLElement|null} */ ((/** @type {Element} */ (event.target)).closest('[data-op]'));
    if (!button) return;
    if (button.getAttribute('aria-disabled') === 'true') {
      actions.showGateMsg(button.title);
      return;
    }
    actions.addOp(/** @type {string} */ (button.dataset.op));
  }

  /** @param {string} opName @returns {void} */
  function addOp(opName) {
    if (page.doc.ops.length >= env.MAX_RECIPE_STEPS) {
      actions.showGateMsg(`rejected: a chain carries at most ${env.MAX_RECIPE_STEPS} ops`);
      return;
    }
    actions.queueCommit(async () => {
      if (page.doc.ops.length >= env.MAX_RECIPE_STEPS) {
        actions.showGateMsg(`rejected: a chain carries at most ${env.MAX_RECIPE_STEPS} ops`);
        return;
      }
      const newOp = { op: opName, params: env.seedOpParams(opName, page.mesh.currentMeshIsCurrent ? page.mesh.currentMesh : null) };
      const check = await actions.chainIsValid(page.doc.base, [...page.doc.ops, newOp]);
      if (!check.ok) {
        actions.showGateMsg(`rejected: ${check.message}`);
        return;
      }
      actions.setOps([...page.doc.ops, newOp]);
      actions.renderOps();
      actions.showGateMsg('');
      actions.update();
    });
  }

  /** @returns {void} */
  function resetOps() {
    actions.queueCommit(async () => {
      if (page.doc.ops.length > 1 && !env.window.confirm(`Clear all ${page.doc.ops.length} operations?`)) return;
      actions.setOps([]);
      actions.renderOps();
      actions.showGateMsg('');
      actions.update();
    });
  }
  return { wireOpControls, reorderOp, renderOps, updateOpParam, removeOp, activateAddOp, addOp, resetOps };
}
