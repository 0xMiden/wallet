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
