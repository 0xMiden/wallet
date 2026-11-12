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

const wireView = {
  outgoing: [],
  incoming: [],
  outgoingNfts: [],
  incomingNfts: [],
  unlistedAssets: 0,
  inputNotesConsumed: 0,
  outputNotesCreated: 1,
  storageChanged: false
};

describe('store.simulateCustomTransaction', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('returns the decoded view and note flow with bigint amounts', async () => {
    mockRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      effects: {
        view: { ...wireView, outgoing: [{ faucetId: 'fA', amount: '500' }], fee: { faucetId: 'fN', amount: '3' } },
        noteFlow: {
          inputCount: 0,
          inputs: [],
          outputs: [{ kind: 'P2ID', visibility: 'public', assets: [{ faucetId: 'fA', amount: '500' }] }]
        }
      }
    });

    const out = await useWalletStore.getState().simulateCustomTransaction('confirm-id-1');

    expect(mockRequest).toHaveBeenCalledWith({
      type: MidenMessageType.DAppSimulateTransactionRequest,
      id: 'confirm-id-1'
    });
    expect(out).toEqual({
      view: { ...wireView, outgoing: [{ faucetId: 'fA', amount: 500n }], fee: { faucetId: 'fN', amount: 3n } },
      noteFlow: {
        inputCount: 0,
        inputs: [],
        outputs: [{ kind: 'P2ID', visibility: 'public', assets: [{ faucetId: 'fA', amount: 500n }] }]
      }
    });
  });

  it('passes through an error with no view', async () => {
    mockRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      error: 'sim failed'
    });

    const out = await useWalletStore.getState().simulateCustomTransaction('id');

    expect(out).toEqual({ error: 'sim failed' });
    expect(out.view).toBeUndefined();
    expect(out.noteFlow).toBeUndefined();
  });

  it('rejects a malformed effects payload', async () => {
    mockRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      effects: { view: { ...wireView, outgoing: [{ faucetId: 'fA', amount: '-1' }] } }
    });

    await expect(useWalletStore.getState().simulateCustomTransaction('id')).rejects.toThrow(
      'malformed simulated effects'
    );
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
