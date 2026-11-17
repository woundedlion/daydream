/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createEffectGui} from '../ui/effect_gui.js';
import {createApplyPipeline, createSwitchCoordinator, ApplyResult} from '../effects/effect_sequencing.js';
import {getChainSnapshot, restoreChainSnapshot} from '../engine/workbench_bindings.js';
import {MOBILE_MEDIA_QUERY} from '../shared/layout.js';
import {copyToClipboard} from '../shared/copy_text.js';
import {replaceUrl} from '../shared/url.js';
import {showFatalError} from '../shared/banner.js';
import {resetGUI} from '../ui/gui.js';
import {resolutionPresets} from '../effects/effect_roster.js';
const EXPORT_NOTICE = 'export';
const CONFIG_NOTICE = 'config';
const SWITCH_NOTICE = 'switch';

/** @param {import('./app_context.js').PanelContext} deps */
export function createAppEffects({doc, win, host, loaded, segments, display, appState, urlSync,
  availableEffects, shaderWorkbench, createGui, applyNotice, shell, engineControls}) {
  // The shader-document controller publishes the chain editor's selected-instance
  // filter through this slot.
  /** @type {{current: {external: true}|null}} */
  const paramFilterRef = { current: null };

  /** @type {{apply: () => string}} */
  const reset = {apply: () => ApplyResult.REJECTED};
  /** @type {{mute: (write: () => void) => void}} */
  const transaction = {mute: (write) => write()};
  let columnDefaultsReady = () => false;
  const {guiInstance, sidebar} = shell;
  const {setEngineParam, setAnimationsPaused, usesChainSnapshot} = engineControls;
  const clearEffectParamUrl = () => resetGUI(
    ['resolution', 'effect', 'view', ...guiInstance.collectUrlKeys()], win);

  const snapshotChain = () => getChainSnapshot(host.engine);
  const restoreChain = (/** @type {*} */ snapshot) => restoreChainSnapshot(host.engine, loaded.module, snapshot);
  const restoreChainApplied = (/** @type {*} */ snapshot) => restoreChain(snapshot)
    === loaded.module.ChainSnapshotRestoreResult.APPLIED;

  const effectGui = createEffectGui({
    moduleDead: (error) => host.moduleDead(error),
    engine: {
      getParameterDefinitions: () => loaded.engine.getParameterDefinitions(),
      getParameterAdvisories: () => loaded.engine.getParameterAdvisories(),
      paramGeneration: () => host.paramGeneration(),
      paramValues: () => loaded.engine.getParamValues(),
      setParam: setEngineParam,
      setAnimationsPaused,
      animationsPaused: () => loaded.engine.getAnimationsPaused(),
      getPresetCount: () => loaded.engine.getPresetCount(),
      getPresetIndex: () => segments.ownsDisplay
        ? (segments.getPresetIndex() ?? loaded.engine.getPresetIndex())
        : loaded.engine.getPresetIndex(),
      synchronizePreset: (index) => loaded.engine.getPresetIndex() === index
        || loaded.engine.synchronizePreset(index),
      selectPreset: (index) => {
        if (!loaded.engine.selectPreset(index)) return false;
        segments.selectPreset(index);
        return true;
      },
    },
    segments: {
      ownsDisplay: () => segments.ownsDisplay,
      paramValues: () => segments.getParamValues(),
      setParam: (name, value) => segments.setParameter(name, value),
    },
    config: {
      inUse: usesChainSnapshot,
      snapshot: snapshotChain,
      restore: restoreChain,
      restoreResults: () => loaded.module.ChainSnapshotRestoreResult,
      showImportNotice: (message) => applyNotice.show(message, CONFIG_NOTICE),
    },
    host: {
      createGui: () => createGui({ autoPlace: false, title: 'Effect' }, 'fx'),
      container: () => shaderWorkbench ? null : doc.getElementById('gui-container'),
      isMobile: () => win.matchMedia?.(MOBILE_MEDIA_QUERY).matches ?? false,
      canPausePresets: () => loaded.engine.getPresetCount() > 1
        || loaded.engine.getParameterDefinitions().some((parameter) => parameter.animated),
      copyText: copyToClipboard,
      showActionNotice: (message) => applyNotice.show(message, EXPORT_NOTICE),
      applyEffect: () => {
        const rejected = reset.apply() !== ApplyResult.APPLIED;
        const notice = rejected
          ? 'Effect reset was rejected. The panel still shows the current values.'
          : null;
        applyNotice.show(notice, SWITCH_NOTICE);
      },
      dragTarget: win,
      focusedElement: () => doc.activeElement,
      paramFilter: () => paramFilterRef.current,
    },
  });

  const apply = createApplyPipeline({
    appState,
    getEngine: () => host.engine,
    getModule: () => loaded.module,
    getChainSnapshot: snapshotChain,
    restoreChainSnapshot: restoreChainApplied,
    invalidateEngineView: () => host.invalidateView(),
    presets: resolutionPresets,
    availableEffects,
    effectGui,
    clearEffectParamUrl,
    segments,
    driver: display,
    sidebar,
    muteSubscription: (write) => transaction.mute(write),
    moduleDead: (error) => host.moduleDead(error),
    onColumnDefault: () => {
      if (columnDefaultsReady()) urlSync.setParam('view.noBlackColumns', null);
    },
  });

  const switches = createSwitchCoordinator({
    appState,
    getActiveEffect: () => effectGui.active(),
    applyEffect: (options) => apply.applyEffect(options),
    applyResolution: (options) => apply.applyResolution(options),
    currentUrl: () =>
      win.location.pathname + win.location.search + win.location.hash,
    restoreUrl: (url) => {
      urlSync.discardPending();
      replaceUrl(url, win);
    },
    showResolution: shell.showResolution,
    syncResolutionUrl: () => urlSync.schedule(),
    logError: (message, error) => console.error(message, error),
    showNotice: (message) => applyNotice.show(message, SWITCH_NOTICE),
    showFatal: showFatalError,
    moduleDead: (error) => host.moduleDead(error),
    usesChainSnapshot,
    getChainSnapshot: snapshotChain,
    restoreChainSnapshot: restoreChainApplied,
  });

  reset.apply = () => apply.applyEffect();
  transaction.mute = (write) => switches.mute(write);
  return {effectGui, apply, switches, paramFilterRef,
    connectViewDisplay(/** @type {ReturnType<typeof import('./view_display_controls.js').createViewDisplayControls>} */ viewDisplay) {
      columnDefaultsReady = () => viewDisplay.columnDefaultsReady();
    }};
}
