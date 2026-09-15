import React from 'react';

import { act, render } from '@testing-library/react';

import { BridgeIntentWatcher } from './BridgeIntentWatcher';

const mockReconcileReceives = jest.fn();
const mockReconcileSends = jest.fn();

jest.mock('./bridge-receive', () => ({
  reconcileBridgedReceives: (...args: unknown[]) => mockReconcileReceives(...args)
}));
jest.mock('lib/wallet-prompts', () => ({
  reconcileBridgedSends: (...args: unknown[]) => mockReconcileSends(...args)
}));

const tick = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

describe('BridgeIntentWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockReconcileReceives.mockResolvedValue(undefined);
    mockReconcileSends.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('reconciles both directions on mount and again on every interval', async () => {
    render(<BridgeIntentWatcher />);
    await act(async () => {});
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);

    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
    expect(mockReconcileSends).toHaveBeenCalledTimes(2);

    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(3);
    expect(mockReconcileSends).toHaveBeenCalledTimes(3);
  });

  it('skips a tick while the previous run is still in flight', async () => {
    let release: () => void = () => {};
    mockReconcileReceives.mockImplementation(() => new Promise<void>(resolve => (release = resolve)));

    render(<BridgeIntentWatcher />);
    await act(async () => {});
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    expect(mockReconcileSends).not.toHaveBeenCalled();

    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);
    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
  });

  it('still polls sends when receives reject, and keeps polling afterwards', async () => {
    mockReconcileReceives.mockRejectedValueOnce(new Error('rpc down'));

    render(<BridgeIntentWatcher />);
    await act(async () => {});

    expect(console.warn).toHaveBeenCalledWith('[bridge-intent-watcher] receives failed', expect.any(Error));
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);

    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
    expect(mockReconcileSends).toHaveBeenCalledTimes(2);
  });

  it('warns and keeps polling when sends reject', async () => {
    mockReconcileSends.mockRejectedValueOnce(new Error('allocator down'));

    render(<BridgeIntentWatcher />);
    await act(async () => {});

    expect(console.warn).toHaveBeenCalledWith('[bridge-intent-watcher] sends failed', expect.any(Error));

    await tick(8_000);
    expect(mockReconcileSends).toHaveBeenCalledTimes(2);
  });

  it('does not poll while the document is hidden', async () => {
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    render(<BridgeIntentWatcher />);
    await tick(8_000);
    expect(mockReconcileReceives).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
  });

  it('stops polling once unmounted', async () => {
    const { unmount } = render(<BridgeIntentWatcher />);
    await act(async () => {});
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);

    unmount();
    await tick(8_000);

    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
  });
});
