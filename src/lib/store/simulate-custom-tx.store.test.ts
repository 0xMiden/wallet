import { MidenMessageType } from 'lib/miden/types';

import { useWalletStore } from './index';

const mockRequest = jest.fn();
const mockIntercomClient = {
  request: mockRequest,
  subscribe: jest.fn(() => () => {})
};
jest.mock('lib/intercom/client', () => ({
  createIntercomClient: jest.fn(() => mockIntercomClient),
  IntercomClient: jest.fn().mockImplementation(() => mockIntercomClient)
}));

describe('store.simulateCustomTransaction', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('sends a simulate request and returns { summaryBytes }', async () => {
    mockRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      summaryBytes: 'sumB64'
    });

    const out = await useWalletStore.getState().simulateCustomTransaction('confirm-id-1');

    expect(mockRequest).toHaveBeenCalledWith({
      type: MidenMessageType.DAppSimulateTransactionRequest,
      id: 'confirm-id-1'
    });
    expect(out).toEqual({ summaryBytes: 'sumB64', error: undefined });
  });

  it('passes through an { error }', async () => {
    mockRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      error: 'sim failed'
    });

    const out = await useWalletStore.getState().simulateCustomTransaction('id');

    expect(out).toEqual({ summaryBytes: undefined, error: 'sim failed' });
  });

  it('passes through { executedBytes } for an already-fully-authorized account', async () => {
    // web-sdk 0.16 produces no TransactionSummary for an ordinary single-sig
    // account (executeForSummary rejects TRANSACTION_ALREADY_AUTHORIZED), so the
    // dry run returns the executed transaction instead. Dropping it here would
    // blank the confirm screen's verified asset view for every such account.
    mockRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      executedBytes: 'execB64'
    });

    const out = await useWalletStore.getState().simulateCustomTransaction('id');

    expect(out).toEqual({ summaryBytes: undefined, executedBytes: 'execB64', error: undefined });
  });

  it('names the unhandled request type when an adapter has no handler for it', async () => {
    // An in-process adapter with no `case` for the type resolves `undefined`.
    // Dereferencing that threw a bare TypeError ("Cannot read properties of
    // undefined (reading 'type')") which surfaced in the UI as a wrong password
    // on Reveal Hot Key rather than as a missing handler.
    mockRequest.mockResolvedValueOnce(undefined);

    await expect(useWalletStore.getState().simulateCustomTransaction('id')).rejects.toThrow(
      `No handler for request type: ${MidenMessageType.DAppSimulateTransactionRequest}`
    );
  });

  it('throws when the response type does not match', async () => {
    mockRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppGetPayloadResponse,
      payload: {}
    });

    await expect(useWalletStore.getState().simulateCustomTransaction('id')).rejects.toThrow(
      'Invalid response received.'
    );
  });
});
