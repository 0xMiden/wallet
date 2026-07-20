/**
 * Unit tests for DesktopDappHandler.
 *
 * Covers the `useDesktopDappHandler` hook (platform gate, listener setup,
 * request→response conversion, error handling, cleanup) and the
 * `DesktopDappHandler` component wrapper + default export.
 *
 * All external boundaries are mocked:
 * - `lib/platform` (isDesktop) — controls the desktop gate.
 * - `lib/dapp-browser/message-handler` (handleWebViewMessage) — the backend.
 * - `./dapp-browser` (onDappWalletRequest / sendDappWalletResponse) — the
 *   Tauri bridge; mocking it also avoids loading `@tauri-apps/api`.
 */

import React from 'react';

import { act, render, renderHook } from '@testing-library/react';

import { useDesktopDappHandler, DesktopDappHandler } from './DesktopDappHandler';
import DefaultExport from './DesktopDappHandler';
import type { DappWalletRequest } from './dapp-browser';

// --- Mocks -----------------------------------------------------------------

const mockIsDesktop = jest.fn<boolean, []>();
jest.mock('lib/platform', () => ({
  isDesktop: () => mockIsDesktop()
}));

const mockHandleWebViewMessage = jest.fn();
jest.mock('lib/dapp-browser/message-handler', () => ({
  handleWebViewMessage: (...args: unknown[]) => mockHandleWebViewMessage(...args)
}));

const mockOnDappWalletRequest = jest.fn();
const mockSendDappWalletResponse = jest.fn();
jest.mock('./dapp-browser', () => ({
  onDappWalletRequest: (...args: unknown[]) => mockOnDappWalletRequest(...args),
  sendDappWalletResponse: (...args: unknown[]) => mockSendDappWalletResponse(...args)
}));

// --- Helpers ---------------------------------------------------------------

type DappRequestCallback = (request: DappWalletRequest, origin: string) => void | Promise<void>;

/** Flush pending microtasks (settles the async `setupListener` in the effect). */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Grab the callback that the hook registered with `onDappWalletRequest`. */
const getRegisteredCallback = (): DappRequestCallback =>
  mockOnDappWalletRequest.mock.calls[0][0] as DappRequestCallback;

const sampleRequest: DappWalletRequest = {
  type: 'MIDEN_CONNECT',
  payload: { some: 'payload' },
  reqId: 'req-123'
};

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults: desktop, listener resolves to a no-op unsubscribe,
  // backend returns a benign response.
  mockIsDesktop.mockReturnValue(true);
  mockOnDappWalletRequest.mockResolvedValue(jest.fn());
  mockSendDappWalletResponse.mockResolvedValue(undefined);
  mockHandleWebViewMessage.mockResolvedValue({ type: 'MIDEN_PAGE_RESPONSE', payload: 'ok', reqId: 'req-123' });
});

// --- Tests -----------------------------------------------------------------

describe('useDesktopDappHandler', () => {
  it('does nothing when not on desktop and cleans up without an unsubscribe', async () => {
    mockIsDesktop.mockReturnValue(false);

    const { unmount } = renderHook(() => useDesktopDappHandler());
    await flush();

    expect(mockOnDappWalletRequest).not.toHaveBeenCalled();

    // Cleanup runs the `if (unsubscribe)` false branch — must not throw.
    expect(() => unmount()).not.toThrow();
  });

  it('registers a wallet-request listener on desktop', async () => {
    renderHook(() => useDesktopDappHandler());
    await flush();

    expect(mockOnDappWalletRequest).toHaveBeenCalledTimes(1);
    expect(mockOnDappWalletRequest).toHaveBeenCalledWith(expect.any(Function));
  });

  it('converts a request, forwards it to the backend, and sends the response back', async () => {
    renderHook(() => useDesktopDappHandler());
    await flush();

    const backendResponse = { type: 'MIDEN_PAGE_RESPONSE', payload: 'done', reqId: 'req-123' };
    mockHandleWebViewMessage.mockResolvedValueOnce(backendResponse);

    const callback = getRegisteredCallback();
    await act(async () => {
      await callback(sampleRequest, 'https://dapp.example');
    });

    // The request is converted into the WebViewMessage shape and forwarded
    // with the origin.
    expect(mockHandleWebViewMessage).toHaveBeenCalledWith(
      { type: 'MIDEN_CONNECT', payload: { some: 'payload' }, reqId: 'req-123' },
      'https://dapp.example'
    );
    // The backend response is sent straight back to the dApp window.
    expect(mockSendDappWalletResponse).toHaveBeenCalledWith(backendResponse);
  });

  it('sends an error response with the Error message when the backend throws an Error', async () => {
    renderHook(() => useDesktopDappHandler());
    await flush();

    mockHandleWebViewMessage.mockRejectedValueOnce(new Error('backend boom'));

    const callback = getRegisteredCallback();
    await act(async () => {
      await callback(sampleRequest, 'https://dapp.example');
    });

    expect(mockSendDappWalletResponse).toHaveBeenCalledWith({
      type: 'MIDEN_PAGE_ERROR_RESPONSE',
      reqId: 'req-123',
      error: 'backend boom'
    });
  });

  it('sends an "Unknown error" response when the backend throws a non-Error', async () => {
    renderHook(() => useDesktopDappHandler());
    await flush();

    // Reject with a non-Error value to hit the `'Unknown error'` branch.
    mockHandleWebViewMessage.mockRejectedValueOnce('just a string');

    const callback = getRegisteredCallback();
    await act(async () => {
      await callback(sampleRequest, 'https://dapp.example');
    });

    expect(mockSendDappWalletResponse).toHaveBeenCalledWith({
      type: 'MIDEN_PAGE_ERROR_RESPONSE',
      reqId: 'req-123',
      error: 'Unknown error'
    });
  });

  it('fails silently when listener setup rejects and cleans up without an unsubscribe', async () => {
    mockOnDappWalletRequest.mockRejectedValueOnce(new Error('setup failed'));

    const { unmount } = renderHook(() => useDesktopDappHandler());
    await flush();

    // No unsubscribe was ever assigned, so cleanup takes the false branch.
    expect(() => unmount()).not.toThrow();
    expect(mockSendDappWalletResponse).not.toHaveBeenCalled();
  });

  it('calls the unsubscribe function on unmount', async () => {
    const unsubscribe = jest.fn();
    mockOnDappWalletRequest.mockResolvedValueOnce(unsubscribe);

    const { unmount } = renderHook(() => useDesktopDappHandler());
    await flush();

    expect(unsubscribe).not.toHaveBeenCalled();

    act(() => {
      unmount();
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('DesktopDappHandler component', () => {
  it('renders nothing and wires up the desktop dApp handler', async () => {
    const { container, unmount } = render(<DesktopDappHandler />);
    await flush();

    // Component returns null — no DOM output.
    expect(container.firstChild).toBeNull();
    // ...but it still registers the listener via the hook.
    expect(mockOnDappWalletRequest).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('is the module default export', () => {
    expect(DefaultExport).toBe(DesktopDappHandler);
  });
});
