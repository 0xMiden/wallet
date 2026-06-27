/**
 * @jest-environment jsdom
 */
import { InAppBrowser, ToolBarType } from '@miden/dapp-browser';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
import { isMobile } from 'lib/platform';

import { openExternalUrl } from './external-browser';

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    addListener: jest.fn(),
    openWebView: jest.fn()
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

  it('cleans up viewport and listener when the overlay close event matches our id', async () => {
    mockIsMobile.mockReturnValue(true);
    let closeHandler: (event: { id?: string }) => Promise<void> = async () => {};
    const removeListener = jest.fn();
    mockAddListener.mockImplementation(async (_event: string, handler: (e: { id?: string }) => Promise<void>) => {
      closeHandler = handler;
      return { remove: removeListener };
    });

    await openExternalUrl({ url: 'https://example.com', title: 'Example' });

    await closeHandler({ id: 'explorer-webview' });

    expect(markReturningFromWebview).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalled();
    expect(resetViewportAfterWebview).toHaveBeenCalled();
  });

  it('ignores close events for other webview instances', async () => {
    mockIsMobile.mockReturnValue(true);
    let closeHandler: (event: { id?: string }) => Promise<void> = async () => {};
    const removeListener = jest.fn();
    mockAddListener.mockImplementation(async (_event: string, handler: (e: { id?: string }) => Promise<void>) => {
      closeHandler = handler;
      return { remove: removeListener };
    });

    await openExternalUrl({ url: 'https://example.com', title: 'Example' });

    await closeHandler({ id: 'some-other-webview' });

    expect(markReturningFromWebview).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();
    expect(resetViewportAfterWebview).not.toHaveBeenCalled();
  });
});
