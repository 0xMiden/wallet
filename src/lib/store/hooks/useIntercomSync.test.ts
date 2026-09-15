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

import { fetchStateFromBackend, retryFetchState } from './useIntercomSync';

const intercom = _g.__intSyncTest.intercomMock;

const readyResponse = {
  type: WalletMessageType.GetStateResponse,
  state: { status: 'Ready', accounts: [] }
};

beforeEach(() => {
  intercom.request.mockReset();
  intercom.subscribe.mockReset().mockReturnValue(() => {});
});

describe('fetchStateFromBackend', () => {
  it('returns the state field of a successful response', async () => {
    intercom.request.mockResolvedValueOnce(readyResponse);
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

describe('retryFetchState', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries until fetchStateFromBackend resolves, then returns state', async () => {
    intercom.request
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(readyResponse);

    const promise = retryFetchState(() => false);
    // Advance past two backoff windows (250ms + 500ms) to unblock retries.
    await jest.advanceTimersByTimeAsync(1_000);

    expect(await promise).toEqual({ status: 'Ready', accounts: [] });
    expect(intercom.request).toHaveBeenCalledTimes(3);
  });

  it('returns null when cancelled between attempts', async () => {
    let cancelled = false;
    intercom.request.mockRejectedValue(new Error('boom'));

    const promise = retryFetchState(() => cancelled);
    // Let the first failure land, then cancel during the backoff wait.
    await jest.advanceTimersByTimeAsync(0);
    cancelled = true;
    await jest.advanceTimersByTimeAsync(5_000);

    expect(await promise).toBeNull();
  });

  it('warns exactly once after 20 failed attempts', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    intercom.request.mockRejectedValue(new Error('boom'));
    let cancelled = false;

    const promise = retryFetchState(() => cancelled);
    // Run >20 attempts: backoff saturates at 3s, so 20 rounds ≈ plenty of slack.
    await jest.advanceTimersByTimeAsync(120_000);
    cancelled = true;
    await jest.advanceTimersByTimeAsync(5_000);
    await promise;

    const wedgedWarns = warn.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('backend unresponsive after 20 attempts')
    );
    expect(wedgedWarns).toHaveLength(1);
    warn.mockRestore();
  });
});
