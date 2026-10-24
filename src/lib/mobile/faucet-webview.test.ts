/**
 * @jest-environment jsdom
 */
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

import { InAppBrowser } from '@miden/dapp-browser';
import { isMobile } from 'lib/platform';
import { THEME_STORAGE_KEY } from 'lib/settings/constants';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { openFaucetWebview } from './faucet-webview';
import { PREVENT_INPUT_ZOOM_SCRIPT } from './prevent-input-zoom';

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    addListener: jest.fn(),
    openWebView: jest.fn(),
    executeScript: jest.fn(),
    close: jest.fn()
  },
  ToolBarType: { NAVIGATION: 'NAVIGATION' }
}));
jest.mock('@capacitor/filesystem', () => ({ Filesystem: { writeFile: jest.fn() }, Directory: { Cache: 'CACHE' } }));
jest.mock('@capacitor/share', () => ({ Share: { share: jest.fn() } }));
jest.mock('lib/mobile/viewport-reset', () => ({ resetViewportAfterWebview: jest.fn() }));
jest.mock('lib/mobile/webview-state', () => ({ markReturningFromWebview: jest.fn() }));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: jest.fn() }));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockAddListener = InAppBrowser.addListener as jest.Mock;
const mockExecuteScript = InAppBrowser.executeScript as jest.Mock;

const injectedCodes = (): string[] => mockExecuteScript.mock.calls.map(([arg]) => (arg as { code: string }).code);

describe('openFaucetWebview — input-zoom prevention (#503)', () => {
  const listeners: Record<string, (event: unknown) => unknown> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(listeners)) delete listeners[key];
    mockIsMobile.mockReturnValue(true);
    mockExecuteScript.mockResolvedValue(undefined);
    mockAddListener.mockImplementation((event: string, cb: (e: unknown) => unknown) => {
      listeners[event] = cb;
      return { remove: jest.fn() };
    });
  });

  it('injects the zoom-prevention script FIRST when the faucet page loads', async () => {
    await openFaucetWebview({ url: 'https://faucet.testnet.miden.io', title: 'Faucet' });

    await listeners['browserPageLoaded']?.({ id: 'faucet-webview' });

    const codes = injectedCodes();
    expect(codes).toContain(PREVENT_INPUT_ZOOM_SCRIPT);
    // Ordering is load-bearing (viewport must be locked before other scripts run),
    // so assert it is the very first executeScript call — not merely present.
    expect(codes[0]).toBe(PREVENT_INPUT_ZOOM_SCRIPT);
  });

  it('does NOT inject into a page-load event from a different browser instance', async () => {
    await openFaucetWebview({ url: 'https://faucet.testnet.miden.io', title: 'Faucet' });

    // A concurrently-open dApp browser finishing load must not trip our injection.
    await listeners['browserPageLoaded']?.({ id: 'some-other-instance' });

    expect(mockExecuteScript).not.toHaveBeenCalled();
  });
});

describe('openFaucetWebview: native header theme (#503)', () => {
  const mockOpenWebView = InAppBrowser.openWebView as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile.mockReturnValue(true);
    mockAddListener.mockResolvedValue({ remove: jest.fn() });
  });
  afterEach(() => localStorage.clear());

  it.each([
    ['dark', '#191919'],
    ['light', '#ffffff']
  ])("colours the header for the app's %s theme", async (theme, toolbarColor) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);

    await openFaucetWebview({ url: 'https://faucet.testnet.miden.io', title: 'Faucet' });

    expect(mockOpenWebView).toHaveBeenCalledWith(expect.objectContaining({ toolbarColor }));
    expect(mockOpenWebView.mock.calls[0][0]).not.toHaveProperty('toolbarTextColor');
  });
});

describe('faucet browser-alert reporting from real message handlers', () => {
  const listeners: Record<string, (event: unknown) => Promise<void>> = {};
  let alertSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;
  const rawDetail =
    'private SDK detail 0x1234 amount 42 abandon ability able about above absent absorb abstract absurd abuse access accident';
  const download = {
    id: 'faucet-webview',
    detail: { type: 'DOWNLOAD_FILE', filename: 'private-note.mno', content: 'private-base64' }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    for (const key of Object.keys(listeners)) delete listeners[key];
    mockIsMobile.mockReturnValue(true);
    mockAddListener.mockImplementation((event: string, callback: (event: unknown) => Promise<void>) => {
      listeners[event] = callback;
      return Promise.resolve({ remove: jest.fn() });
    });
    jest.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'file:///private-note.mno' });
    jest.mocked(Share.share).mockResolvedValue({ activityType: 'save' });
    jest.mocked(InAppBrowser.close).mockResolvedValue(undefined);
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    alertSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('reports the raw download error after showing the original browser alert', async () => {
    jest.mocked(Filesystem.writeFile).mockRejectedValueOnce(new Error(rawDetail));
    await openFaucetWebview({ url: 'https://faucet.testnet.miden.io', title: 'Faucet' });
    alertSpy.mockImplementation(() => expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]));
    await listeners.messageFromWebview!(download);
    expect(alertSpy.mock.calls).toEqual([['Error: ' + rawDetail]]);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_faucet_download_failed', 'browser_alert']]);
  });

  it('reports the raw share error only after the delayed share shows its alert', async () => {
    jest.mocked(Share.share).mockRejectedValueOnce(new Error(rawDetail));
    await openFaucetWebview({ url: 'https://faucet.testnet.miden.io', title: 'Faucet' });
    await listeners.messageFromWebview!(download);
    await jest.advanceTimersByTimeAsync(999);
    expect(alertSpy.mock.calls).toEqual([]);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    alertSpy.mockImplementation(() => expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]));
    await jest.advanceTimersByTimeAsync(1);
    expect(alertSpy.mock.calls).toEqual([['Share error: ' + rawDetail]]);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_faucet_share_failed', 'browser_alert']]);
  });

  it('keeps a successfully saved download quiet', async () => {
    await openFaucetWebview({ url: 'https://faucet.testnet.miden.io', title: 'Faucet' });
    await listeners.messageFromWebview!(download);
    await jest.advanceTimersByTimeAsync(1000);
    expect(Share.share).toHaveBeenCalledWith({
      files: ['file:///private-note.mno'],
      dialogTitle: 'Save private-note.mno'
    });
    expect(alertSpy.mock.calls).toEqual([]);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
  });

  it('keeps informational success and user-close events quiet', async () => {
    await openFaucetWebview({ url: 'https://faucet.testnet.miden.io', title: 'Faucet' });
    await listeners.messageFromWebview!({ id: 'faucet-webview', detail: { type: 'PUBLIC_NOTE_SUCCESS' } });
    await listeners.closeEvent!({ id: 'faucet-webview' });
    expect(InAppBrowser.close).toHaveBeenCalledWith({ id: 'faucet-webview' });
    expect(alertSpy.mock.calls).toEqual([]);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
  });

  it('keeps another browser instance and incomplete download messages quiet', async () => {
    await openFaucetWebview({ url: 'https://faucet.testnet.miden.io', title: 'Faucet' });
    await listeners.messageFromWebview!({ ...download, id: 'other-instance' });
    await listeners.messageFromWebview!({ id: 'faucet-webview', detail: { type: 'DOWNLOAD_FILE' } });
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    expect(alertSpy.mock.calls).toEqual([]);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
  });
});
