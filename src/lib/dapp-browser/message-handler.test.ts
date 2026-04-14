/* eslint-disable import/first */
/**
 * Tests for the dApp WebView message handler — the wallet's untrusted
 * boundary with the dApp page. Every message the dApp posts goes
 * through this function before reaching `processDApp`, so this is
 * where shape validation has to hold.
 *
 * The backend `processDApp` is mocked so we can assert the handler's
 * dispatch behavior without touching the real backend queue. jest.mock
 * calls are hoisted above imports at runtime, so the imports below
 * correctly see the mocked modules — the `import/first` ESLint rule
 * doesn't know that, hence the disable.
 */

const mockProcessDApp = jest.fn();
jest.mock('lib/miden/back/actions', () => ({
  processDApp: (...args: unknown[]) => mockProcessDApp(...args)
}));

import type { WebViewMessage } from './message-handler';
import { handleWebViewMessage } from './message-handler';

beforeEach(() => {
  mockProcessDApp.mockReset();
});

const ORIGIN = 'https://miden.xyz';

describe('PING', () => {
  it('responds to PING with PONG without touching processDApp', async () => {
    const msg: WebViewMessage = { type: 'MIDEN_PAGE_REQUEST', payload: 'PING', reqId: 'req-1' };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res).toEqual({ type: 'MIDEN_PAGE_RESPONSE', payload: 'PONG', reqId: 'req-1' });
    expect(mockProcessDApp).not.toHaveBeenCalled();
  });
});

describe('S11 shape guard', () => {
  // The reviewer explicitly asked: malformed payloads must return
  // MIDEN_PAGE_ERROR_RESPONSE and MUST NOT reach processDApp. Every
  // case below guards that contract.

  it('rejects null payload without dispatching', async () => {
    const msg = { type: 'MIDEN_PAGE_REQUEST', payload: null as never, reqId: 'req-null' };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_ERROR_RESPONSE');
    expect(res.reqId).toBe('req-null');
    expect(res.error).toBeDefined();
    expect(mockProcessDApp).not.toHaveBeenCalled();
  });

  it('rejects non-PING string payload without dispatching', async () => {
    const msg = { type: 'MIDEN_PAGE_REQUEST', payload: 'arbitrary-string' as never, reqId: 'req-str' };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_ERROR_RESPONSE');
    expect(mockProcessDApp).not.toHaveBeenCalled();
  });

  it('rejects numeric payload without dispatching', async () => {
    const msg = { type: 'MIDEN_PAGE_REQUEST', payload: 42 as never, reqId: 'req-num' };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_ERROR_RESPONSE');
    expect(mockProcessDApp).not.toHaveBeenCalled();
  });

  it('rejects object without a type field', async () => {
    const msg = { type: 'MIDEN_PAGE_REQUEST', payload: { foo: 'bar' } as never, reqId: 'req-notype' };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_ERROR_RESPONSE');
    expect(mockProcessDApp).not.toHaveBeenCalled();
  });

  it('rejects object with non-string type field', async () => {
    const msg = { type: 'MIDEN_PAGE_REQUEST', payload: { type: 42 } as never, reqId: 'req-numtype' };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_ERROR_RESPONSE');
    expect(mockProcessDApp).not.toHaveBeenCalled();
  });
});

describe('dispatch to processDApp', () => {
  it('passes origin, request, and undefined sessionId when no sessionId is provided', async () => {
    mockProcessDApp.mockResolvedValue({ type: 'PermissionResponse' });
    const msg: WebViewMessage = {
      type: 'MIDEN_PAGE_REQUEST',
      payload: { type: 'PermissionRequest', force: false } as never,
      reqId: 'req-perm'
    };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(mockProcessDApp).toHaveBeenCalledTimes(1);
    expect(mockProcessDApp).toHaveBeenCalledWith(ORIGIN, { type: 'PermissionRequest', force: false }, undefined);
    expect(res).toEqual({
      type: 'MIDEN_PAGE_RESPONSE',
      payload: { type: 'PermissionResponse' },
      reqId: 'req-perm'
    });
  });

  it('threads sessionId through to processDApp (multi-instance)', async () => {
    mockProcessDApp.mockResolvedValue({ type: 'TransactionResponse', transactionId: 'tx-1' });
    const msg: WebViewMessage = {
      type: 'MIDEN_PAGE_REQUEST',
      payload: { type: 'TransactionRequest' } as never,
      reqId: 'req-tx'
    };
    await handleWebViewMessage(msg, ORIGIN, 'session-abc');
    expect(mockProcessDApp).toHaveBeenCalledWith(ORIGIN, { type: 'TransactionRequest' }, 'session-abc');
  });

  it('wraps null response from processDApp as payload: null (not undefined)', async () => {
    mockProcessDApp.mockResolvedValue(undefined);
    const msg: WebViewMessage = {
      type: 'MIDEN_PAGE_REQUEST',
      payload: { type: 'DisconnectRequest' } as never,
      reqId: 'req-disc'
    };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_RESPONSE');
    expect(res.payload).toBeNull();
  });
});

describe('error wrapping', () => {
  it('converts a thrown Error into MIDEN_PAGE_ERROR_RESPONSE with the message', async () => {
    mockProcessDApp.mockRejectedValue(new Error('NotGranted'));
    const msg: WebViewMessage = {
      type: 'MIDEN_PAGE_REQUEST',
      payload: { type: 'TransactionRequest' } as never,
      reqId: 'req-reject'
    };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_ERROR_RESPONSE');
    expect(res.error).toBe('NotGranted');
    expect(res.reqId).toBe('req-reject');
    expect(res.payload).toBeNull();
  });

  it('stringifies non-Error throws into the error field', async () => {
    mockProcessDApp.mockRejectedValue('something broke');
    const msg: WebViewMessage = {
      type: 'MIDEN_PAGE_REQUEST',
      payload: { type: 'TransactionRequest' } as never,
      reqId: 'req-reject-str'
    };
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_ERROR_RESPONSE');
    expect(res.error).toBe('something broke');
  });

  it('never rejects — always returns a WebViewResponse', async () => {
    mockProcessDApp.mockImplementation(() => {
      throw new Error('sync throw inside processDApp');
    });
    const msg: WebViewMessage = {
      type: 'MIDEN_PAGE_REQUEST',
      payload: { type: 'TransactionRequest' } as never,
      reqId: 'req-sync'
    };
    // If the handler throws, this await would reject — the test would fail.
    const res = await handleWebViewMessage(msg, ORIGIN);
    expect(res.type).toBe('MIDEN_PAGE_ERROR_RESPONSE');
    expect(res.error).toBe('sync throw inside processDApp');
  });
});

describe('reqId round-trip', () => {
  it('preserves the reqId across all response shapes', async () => {
    mockProcessDApp.mockResolvedValue({ type: 'PermissionResponse' });
    const res1 = await handleWebViewMessage({ type: 'MIDEN_PAGE_REQUEST', payload: 'PING', reqId: 'id-ping' }, ORIGIN);
    const res2 = await handleWebViewMessage(
      { type: 'MIDEN_PAGE_REQUEST', payload: { type: 'PermissionRequest' } as never, reqId: 'id-ok' },
      ORIGIN
    );
    const res3 = await handleWebViewMessage(
      { type: 'MIDEN_PAGE_REQUEST', payload: null as never, reqId: 'id-bad' },
      ORIGIN
    );
    expect(res1.reqId).toBe('id-ping');
    expect(res2.reqId).toBe('id-ok');
    expect(res3.reqId).toBe('id-bad');
  });
});
