/**
 * @jest-environment jsdom
 */
import { InAppBrowser, ToolBarType } from '@miden/dapp-browser';
import { onExternalPageFailed } from 'lib/mobile/external-page-failed';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
import { isMobile } from 'lib/platform';
import { THEME_STORAGE_KEY } from 'lib/settings/constants';

import { openExternalUrl } from './external-browser';

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    addListener: jest.fn(),
    openWebView: jest.fn(),
    close: jest.fn()
  },
  ToolBarType: {
    NAVIGATION: 'NAVIGATION'
  }
}));

jest.mock('lib/mobile/viewport-reset', () => ({
  resetViewportAfterWebview: jest.fn()
}));

jest.mock('lib/mobile/webview-state', () => ({
  markReturningFromWebview: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn()
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockAddListener = InAppBrowser.addListener as jest.Mock;
const mockOpenWebView = InAppBrowser.openWebView as jest.Mock;
const mockClose = InAppBrowser.close as jest.Mock;

type ListenerEvent = { id?: string };
type Handler = (event: ListenerEvent) => Promise<void>;

/** Records each listener and its remove() by event name, whatever order they register in. */
function captureListeners() {
  const handlers = new Map<string, Handler>();
  const removers = new Map<string, jest.Mock>();
  mockAddListener.mockImplementation(async (eventName: string, handler: Handler) => {
    const remove = jest.fn();
    handlers.set(eventName, handler);
    removers.set(eventName, remove);
    return { remove };
  });
  return {
    fire: (eventName: string, event: ListenerEvent) => handlers.get(eventName)!(event),
    removed: (eventName: string) => removers.get(eventName)!
  };
}

describe('openExternalUrl', () => {
  let windowOpenSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    windowOpenSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    windowOpenSpy.mockRestore();
  });

  it('opens a new tab on desktop via window.open', async () => {
    mockIsMobile.mockReturnValue(false);

    await openExternalUrl({ url: 'https://testnet.midenscan.com/tx/0xabc', title: 'Midenscan' });

    expect(windowOpenSpy).toHaveBeenCalledWith('https://testnet.midenscan.com/tx/0xabc', '_blank');
    expect(mockOpenWebView).not.toHaveBeenCalled();
  });

  it('opens an InAppBrowser overlay on mobile', async () => {
    mockIsMobile.mockReturnValue(true);
    mockAddListener.mockResolvedValue({ remove: jest.fn() });

    await openExternalUrl({ url: 'https://testnet.midenscan.com/tx/0xabc', title: 'Midenscan' });

    expect(windowOpenSpy).not.toHaveBeenCalled();
    expect(mockOpenWebView).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'explorer-webview',
        url: 'https://testnet.midenscan.com/tx/0xabc',
        title: 'Midenscan',
        toolbarType: ToolBarType.NAVIGATION,
        showReloadButton: true,
        isPresentAfterPageLoad: false
      })
    );
  });

  it('honors a custom instance id on mobile', async () => {
    mockIsMobile.mockReturnValue(true);
    mockAddListener.mockResolvedValue({ remove: jest.fn() });

    await openExternalUrl({ url: 'https://example.com', title: 'Example', id: 'custom-id' });

    expect(mockOpenWebView).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom-id' }));
  });

  it('cleans up viewport and every listener when the overlay close event matches our id', async () => {
    mockIsMobile.mockReturnValue(true);
    const listeners = captureListeners();

    await openExternalUrl({ url: 'https://example.com', title: 'Example' });

    await listeners.fire('closeEvent', { id: 'explorer-webview' });

    expect(markReturningFromWebview).toHaveBeenCalled();
    expect(listeners.removed('closeEvent')).toHaveBeenCalled();
    expect(listeners.removed('pageLoadError')).toHaveBeenCalled();
    expect(listeners.removed('browserPageLoaded')).toHaveBeenCalled();
    expect(resetViewportAfterWebview).toHaveBeenCalled();
  });

  it('ignores close events for other webview instances', async () => {
    mockIsMobile.mockReturnValue(true);
    const listeners = captureListeners();

    await openExternalUrl({ url: 'https://example.com', title: 'Example' });

    await listeners.fire('closeEvent', { id: 'some-other-webview' });

    expect(markReturningFromWebview).not.toHaveBeenCalled();
    expect(listeners.removed('closeEvent')).not.toHaveBeenCalled();
    expect(resetViewportAfterWebview).not.toHaveBeenCalled();
  });

  describe('a page that fails to load', () => {
    const announced = jest.fn();
    let unsubscribe: () => void;

    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
      mockClose.mockResolvedValue(undefined);
      unsubscribe = onExternalPageFailed(announced);
    });
    afterEach(() => unsubscribe());

    it('closes its own overlay once and announces the failure once, even when the error repeats', async () => {
      const listeners = captureListeners();

      await openExternalUrl({ url: 'https://example.com', title: 'Example', id: 'custom-id' });

      await listeners.fire('pageLoadError', { id: 'custom-id' });
      await listeners.fire('pageLoadError', { id: 'custom-id' });

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledWith({ id: 'custom-id' });
      expect(announced).toHaveBeenCalledTimes(1);
    });

    it('stops listening before the close and announces only once the close has resolved', async () => {
      const listeners = captureListeners();
      let finishClose: () => void = () => {};
      mockClose.mockReturnValue(
        new Promise<void>(resolve => {
          finishClose = resolve;
        })
      );

      await openExternalUrl({ url: 'https://example.com', title: 'Example' });

      const handled = listeners.fire('pageLoadError', { id: 'explorer-webview' });

      expect(listeners.removed('pageLoadError')).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledWith({ id: 'explorer-webview' });
      expect(announced).not.toHaveBeenCalled();

      finishClose();
      await handled;

      expect(announced).toHaveBeenCalledTimes(1);
    });

    it('keeps a page open that fails after its initial load', async () => {
      const listeners = captureListeners();

      await openExternalUrl({ url: 'https://example.com', title: 'Example' });

      await listeners.fire('browserPageLoaded', { id: 'explorer-webview' });
      await listeners.fire('pageLoadError', { id: 'explorer-webview' });

      expect(mockClose).not.toHaveBeenCalled();
      expect(announced).not.toHaveBeenCalled();
    });

    it("still closes on its own initial failure when another instance's page loaded", async () => {
      const listeners = captureListeners();

      await openExternalUrl({ url: 'https://example.com', title: 'Example' });

      await listeners.fire('browserPageLoaded', { id: 'some-other-webview' });
      await listeners.fire('pageLoadError', { id: 'explorer-webview' });

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(announced).toHaveBeenCalledTimes(1);
    });

    it('ignores a load error from another instance', async () => {
      const listeners = captureListeners();

      await openExternalUrl({ url: 'https://example.com', title: 'Example' });

      await listeners.fire('pageLoadError', { id: 'some-other-webview' });

      expect(mockClose).not.toHaveBeenCalled();
      expect(listeners.removed('pageLoadError')).not.toHaveBeenCalled();
      expect(announced).not.toHaveBeenCalled();
    });
  });

  describe('native header theme (#503)', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
      mockAddListener.mockResolvedValue({ remove: jest.fn() });
    });
    afterEach(() => localStorage.clear());

    it("colours the header with the app's theme, not the phone's", async () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');

      await openExternalUrl({ url: 'https://testnet.midenscan.com/tx/0xabc', title: 'Midenscan' });

      expect(mockOpenWebView).toHaveBeenCalledWith(expect.objectContaining({ toolbarColor: '#191919' }));
      expect(mockOpenWebView.mock.calls[0][0]).not.toHaveProperty('toolbarTextColor');
    });

    it('reads the theme at every open, so a theme switched since the last one applies', async () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      await openExternalUrl({ url: 'https://testnet.midenscan.com/tx/0xabc', title: 'Midenscan' });
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      await openExternalUrl({ url: 'https://testnet.midenscan.com/tx/0xdef', title: 'Midenscan' });

      expect(mockOpenWebView).toHaveBeenNthCalledWith(1, expect.objectContaining({ toolbarColor: '#191919' }));
      expect(mockOpenWebView).toHaveBeenNthCalledWith(2, expect.objectContaining({ toolbarColor: '#ffffff' }));
      expect(mockOpenWebView.mock.calls[1][0]).not.toHaveProperty('toolbarTextColor');
    });
  });
});
