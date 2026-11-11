import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEffectPanelView} from '../src/ui/effect_panel_view.js';
import {fakeElement, installDocument, restoreDocumentAfterEach} from './helpers/fake_dom.js';

restoreDocumentAfterEach();

test('panel rebuild focus returns to root and stage title buttons', () => {
  installDocument({activeElement: null});
  const folder = () => ({domElement: fakeElement('div'), closed: false,
    titleElement: fakeElement('button', {connected: true}), open() {}, close() {}});
  const record = () => ({gui: folder(), pause: {}, stageFolders: new Map([['source', folder()]])});
  const view = createEffectPanelView({focusedElement: () => document.activeElement,
    guiContainer: () => null, isMobile: () => false});
  for (const stage of [false, true]) {
    const before = record();
    const after = record();
    const title = fx => stage ? fx.stageFolders.get('source').titleElement : fx.gui.titleElement;
    title(before).focus();
    const captured = view.capture(before);
    document.activeElement = null;
    view.restore(after, captured);
    assert.equal(document.activeElement, title(after));
  }
});
