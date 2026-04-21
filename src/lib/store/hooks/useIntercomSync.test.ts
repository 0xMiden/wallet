/* eslint-disable import/first */

const _g = globalThis as any;
_g.__intSyncTest = {
  intercomMock: {
    request: jest.fn(),
    subscribe: jest.fn(() => () => {})
  }
};

jest.mock('lib/store', () => ({
  getIntercom: () => (globalThis as any).__intSyncTest.intercomMock,
  useWalletStore: { getState: () => ({}) }
}));

jest.mock('lib/store/utils/updateBalancesFromSyncData', () => ({
  updateBalancesFromSyncData: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true)
}));

import { WalletMessageType } from 'lib/shared/types';

import { fetchStateFromBackend } from './useIntercomSync';

const intercom = _g.__intSyncTest.intercomMock;

beforeEach(() => {
  intercom.request.mockReset();
  intercom.subscribe.mockReset().mockReturnValue(() => {});
});

describe('fetchStateFromBackend', () => {
  it('returns the state field of a successful response', async () => {
    intercom.request.mockResolvedValueOnce({
      type: WalletMessageType.GetStateResponse,
      state: { status: 'Ready', accounts: [] }
    });
    const state = await fetchStateFromBackend();
    expect(state).toEqual({ status: 'Ready', accounts: [] });
  });

  it('throws when the response type is wrong', async () => {
    intercom.request.mockResolvedValue({ type: 'WrongType' });
    await expect(fetchStateFromBackend()).rejects.toThrow('Invalid response type');
  });

  it('is a single attempt — the caller owns any retry loop', async () => {
    intercom.request.mockResolvedValueOnce({ type: 'WrongType' });
    await expect(fetchStateFromBackend()).rejects.toThrow('Invalid response type');
    expect(intercom.request).toHaveBeenCalledTimes(1);
  });
});
