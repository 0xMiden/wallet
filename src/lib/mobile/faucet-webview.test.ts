/**
 * @jest-environment jsdom
 */
import { InAppBrowser } from '@miden/dapp-browser';
import { isMobile } from 'lib/platform';

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
