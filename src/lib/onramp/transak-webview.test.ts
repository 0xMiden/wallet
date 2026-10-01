/**
 * @jest-environment jsdom
 */
import { InAppBrowser } from '@miden/dapp-browser';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
import { captureCrash } from 'lib/telemetry/crash';

import {
  TRANSAK_BRIDGE_SCRIPT,
  TRANSAK_INSTANCE_ID,
  TRANSAK_NO_EVENTS_TIMEOUT_MS,
  openTransakWidget
} from './transak-webview';

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    addListener: jest.fn(),
    openWebView: jest.fn(),
    close: jest.fn()
  },
  ToolBarType: { NAVIGATION: 'NAVIGATION' }
}));
jest.mock('lib/mobile/viewport-reset', () => ({ resetViewportAfterWebview: jest.fn() }));
jest.mock('lib/mobile/webview-state', () => ({ markReturningFromWebview: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => true) }));
jest.mock('lib/telemetry/crash', () => ({ captureCrash: jest.fn() }));

const EVM_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const OTHER_ADDRESS = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const WIDGET_URL = 'https://global-stg.transak.com?apiKey=key&sessionId=session';

// SYNTHETIC payload. The spike replaces it with one captured from the staging widget.
function syntheticOrderCreated(walletAddress: string): string {
  return JSON.stringify({
    eventName: 'TRANSAK_ORDER_CREATED',
    data: { walletAddress, fiatAmount: 50, cryptoCurrency: 'USDC', network: 'ethereum' }
  });
}

type Listener = (event: object) => Promise<void> | void;

const mockAddListener = jest.mocked(InAppBrowser.addListener);
const mockOpenWebView = jest.mocked(InAppBrowser.openWebView);
const mockClose = jest.mocked(InAppBrowser.close);
const mockCaptureCrash = jest.mocked(captureCrash);

let listeners: Map<string, Listener>;
let removers: jest.Mock[];

function emit(eventName: string, event: object): Promise<void> | void {
  return listeners.get(eventName)?.(event);
}

async function open() {
  const onMismatch = jest.fn();
  const onClosed = jest.fn();
  await openTransakWidget({
    url: WIDGET_URL,
    expected: { evmAddress: EVM_ADDRESS, fiatAmount: '50' },
    onMismatch,
    onClosed
  });
  return { onMismatch, onClosed };
}

function capturedTags(): string[] {
  return mockCaptureCrash.mock.calls.map(([error]) => (error instanceof Error ? error.name : ''));
}

describe('openTransakWidget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    listeners = new Map();
    removers = [];
    mockAddListener.mockImplementation(async (eventName: string, listener: Listener) => {
      listeners.set(eventName, listener);
      const remove = jest.fn(async () => {
        listeners.delete(eventName);
      });
      removers.push(remove);
      return { remove };
    });
    mockOpenWebView.mockResolvedValue({ id: TRANSAK_INSTANCE_ID });
    mockClose.mockImplementation(async () => {
      await emit('closeEvent', { id: TRANSAK_INSTANCE_ID, url: WIDGET_URL });
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens the widget with the bridge script at document start', async () => {
    await open();

    expect(mockOpenWebView).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TRANSAK_INSTANCE_ID,
        url: WIDGET_URL,
        preShowScript: TRANSAK_BRIDGE_SCRIPT,
        preShowScriptInjectionTime: 'documentStart',
        isPresentAfterPageLoad: true
      })
    );
    expect(TRANSAK_BRIDGE_SCRIPT).toContain('window.Android');
    expect(TRANSAK_BRIDGE_SCRIPT).toContain('IosWebview');
    expect(TRANSAK_BRIDGE_SCRIPT).toContain("addEventListener('message'");
  });

  it('closes the widget and calls onMismatch on an event for another wallet', async () => {
    const { onMismatch, onClosed } = await open();

    await emit('messageFromWebview', {
      id: TRANSAK_INSTANCE_ID,
      detail: { transak: syntheticOrderCreated(OTHER_ADDRESS) }
    });

    expect(mockClose).toHaveBeenCalledWith({ id: TRANSAK_INSTANCE_ID });
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(capturedTags()).toEqual(['transak-address-mismatch']);
    expect(JSON.stringify(mockCaptureCrash.mock.calls)).not.toMatch(/0x/i);
  });

  it('does nothing on an event for the expected wallet', async () => {
    const { onMismatch } = await open();

    await emit('messageFromWebview', {
      id: TRANSAK_INSTANCE_ID,
      detail: { transak: syntheticOrderCreated(EVM_ADDRESS) }
    });

    expect(mockClose).not.toHaveBeenCalled();
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('ignores events while the last URL is not on transak.com', async () => {
    const { onMismatch } = await open();

    await emit('urlChangeEvent', { id: TRANSAK_INSTANCE_ID, url: 'https://evil.example/fake-transak' });
    await emit('messageFromWebview', {
      id: TRANSAK_INSTANCE_ID,
      detail: { transak: syntheticOrderCreated(OTHER_ADDRESS) }
    });

    expect(mockClose).not.toHaveBeenCalled();
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('checks events again after the URL comes back to transak.com', async () => {
    const { onMismatch } = await open();

    await emit('urlChangeEvent', { id: TRANSAK_INSTANCE_ID, url: 'https://evil.example/' });
    await emit('urlChangeEvent', { id: TRANSAK_INSTANCE_ID, url: 'https://global-stg.transak.com/order' });
    await emit('messageFromWebview', {
      id: TRANSAK_INSTANCE_ID,
      detail: { transak: syntheticOrderCreated(OTHER_ADDRESS) }
    });

    expect(onMismatch).toHaveBeenCalledTimes(1);
  });

  it('ignores events from another webview instance', async () => {
    const { onMismatch } = await open();

    await emit('messageFromWebview', {
      id: 'dapp-browser',
      detail: { transak: syntheticOrderCreated(OTHER_ADDRESS) }
    });

    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('removes every listener, resets the viewport and calls onClosed once on close', async () => {
    const { onClosed } = await open();
    expect(removers).toHaveLength(3);

    await emit('closeEvent', { id: TRANSAK_INSTANCE_ID, url: WIDGET_URL });

    for (const remove of removers) {
      expect(remove).toHaveBeenCalled();
    }
    expect(listeners.size).toBe(0);
    expect(markReturningFromWebview).toHaveBeenCalledTimes(1);
    expect(resetViewportAfterWebview).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('ignores a close event from another webview instance', async () => {
    const { onClosed } = await open();

    await emit('closeEvent', { id: 'explorer-webview', url: 'https://example.com' });

    expect(onClosed).not.toHaveBeenCalled();
    expect(listeners.size).toBe(3);
  });

  it('reports transak-guard-no-events when no Transak event arrives in time, and keeps the widget open', async () => {
    await open();

    jest.advanceTimersByTime(TRANSAK_NO_EVENTS_TIMEOUT_MS);

    expect(capturedTags()).toEqual(['transak-guard-no-events']);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('does not report no-events when a Transak event arrived', async () => {
    await open();

    await emit('messageFromWebview', {
      id: TRANSAK_INSTANCE_ID,
      detail: { transak: JSON.stringify({ eventName: 'TRANSAK_WIDGET_OPEN', data: true }) }
    });
    jest.advanceTimersByTime(TRANSAK_NO_EVENTS_TIMEOUT_MS);

    expect(mockCaptureCrash).not.toHaveBeenCalled();
  });

  it('clears the no-events timer on close', async () => {
    await open();

    await emit('closeEvent', { id: TRANSAK_INSTANCE_ID, url: WIDGET_URL });
    jest.advanceTimersByTime(TRANSAK_NO_EVENTS_TIMEOUT_MS);

    expect(mockCaptureCrash).not.toHaveBeenCalled();
  });

  it('removes its listeners when the widget fails to open', async () => {
    mockOpenWebView.mockRejectedValueOnce(new Error('no webview'));

    await expect(open()).rejects.toThrow('no webview');

    expect(listeners.size).toBe(0);
  });
});
