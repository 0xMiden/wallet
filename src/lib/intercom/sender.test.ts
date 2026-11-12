import { isExtensionPageSender, isOffscreenDocumentSender } from './sender';

const ID = 'own';
const BASE = 'chrome-extension://own/';
const OFFSCREEN = `${BASE}offscreen.html`;

describe('isExtensionPageSender', () => {
  it('recognises every extension page, in a tab or not', () => {
    expect(isExtensionPageSender({ id: ID, url: `${BASE}popup.html` }, ID, BASE)).toBe(true);
    expect(isExtensionPageSender({ id: ID, url: `${BASE}fullpage.html`, tab: { id: 3 } }, ID, BASE)).toBe(true);
  });

  it('rejects a content script, a lookalike origin, another extension and a missing url', () => {
    expect(isExtensionPageSender({ id: ID, url: 'https://dapp.example/', tab: { id: 3 } }, ID, BASE)).toBe(false);
    expect(isExtensionPageSender({ id: ID, url: 'chrome-extension://own-evil/popup.html' }, ID, BASE)).toBe(false);
    expect(isExtensionPageSender({ id: 'other', url: `${BASE}popup.html` }, ID, BASE)).toBe(false);
    expect(isExtensionPageSender({ id: ID }, ID, BASE)).toBe(false);
    expect(isExtensionPageSender(undefined, ID, BASE)).toBe(false);
    expect(isExtensionPageSender({ id: ID, url: `${BASE}popup.html` }, ID, 'chrome-extension://own')).toBe(false);
  });

  it('works with a Firefox base url', () => {
    expect(isExtensionPageSender({ id: ID, url: 'moz-extension://uuid/popup.html' }, ID, 'moz-extension://uuid/')).toBe(
      true
    );
  });
});

describe('isOffscreenDocumentSender', () => {
  it('recognises only the offscreen document', () => {
    expect(isOffscreenDocumentSender({ id: ID, url: OFFSCREEN }, ID, OFFSCREEN)).toBe(true);
    expect(isOffscreenDocumentSender({ id: ID, url: `${OFFSCREEN}?a` }, ID, OFFSCREEN)).toBe(true);
    expect(isOffscreenDocumentSender({ id: ID, url: `${OFFSCREEN}#b` }, ID, OFFSCREEN)).toBe(true);
    expect(isOffscreenDocumentSender({ id: ID, url: `${BASE}popup.html` }, ID, OFFSCREEN)).toBe(false);
    expect(isOffscreenDocumentSender({ id: ID, url: `${OFFSCREEN}x` }, ID, OFFSCREEN)).toBe(false);
    expect(isOffscreenDocumentSender({ id: ID, url: OFFSCREEN, tab: { id: 1 } }, ID, OFFSCREEN)).toBe(false);
    expect(isOffscreenDocumentSender({ id: 'other', url: OFFSCREEN }, ID, OFFSCREEN)).toBe(false);
    expect(isOffscreenDocumentSender({ id: ID }, ID, OFFSCREEN)).toBe(false);
    expect(isOffscreenDocumentSender(undefined, ID, OFFSCREEN)).toBe(false);
  });
});
