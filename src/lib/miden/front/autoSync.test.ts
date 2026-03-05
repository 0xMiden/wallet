import { WalletStatus } from 'lib/shared/types';

import { Sync } from './autoSync';

const mockSyncState = jest.fn();
const mockSetSyncStatus = jest.fn();

// Mock lib/platform
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  isDesktop: jest.fn(() => false),
  isExtension: jest.fn(() => true)
}));

jest.mock('../sdk/miden-client', () => {
  return {
    getMidenClient: jest.fn(() =>
      Promise.resolve({
        syncState: mockSyncState
      })
    ),
    withWasmClientLock: jest.fn(callback => callback())
  };
});

// Mock the store to return Ready status
jest.mock('lib/store', () => ({
  useWalletStore: {
    getState: jest.fn(() => ({
      status: WalletStatus.Ready,
      isTransactionModalOpen: false,
      setSyncStatus: mockSetSyncStatus
    }))
  }
}));

// Helper to advance time and flush promises in an interleaved way
async function advanceTimeAndFlush(ms: number, steps = 50) {
  const stepMs = ms / steps;
  for (let i = 0; i < steps; i++) {
    jest.advanceTimersByTime(stepMs);
    // Multiple flushes needed for deeply nested async operations (syncLog calls)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('AutoSync', () => {
  let sync: Sync;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockSetSyncStatus.mockClear();
    sync = new Sync();

    // Mock getCurrentUrl to return localhost by default
    jest.spyOn(sync, 'getCurrentUrl').mockReturnValue('http://localhost');

    let blockNum = 0;
    mockSyncState.mockImplementation(() => {
      blockNum += 1;
      return Promise.resolve({
        blockNum: () => blockNum
      });
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should start syncing when state becomes Ready', async () => {
    expect(sync.lastHeight).toBe(0);
    expect(sync.state).toBeUndefined();

    // Transition from undefined to Ready triggers sync
    sync.updateState({ status: WalletStatus.Ready } as any);

    await advanceTimeAndFlush(100);

    expect(mockSyncState).toHaveBeenCalled();
    expect(sync.lastHeight).toBe(1);
  });

  it('should sync automatically and repeatedly', async () => {
    sync.updateState({ status: WalletStatus.Ready } as any);

    await advanceTimeAndFlush(100);
    expect(mockSyncState).toHaveBeenCalledTimes(1);
    expect(sync.lastHeight).toBe(1);

    // Sync interval is 3 seconds
    await advanceTimeAndFlush(3100);
    expect(mockSyncState).toHaveBeenCalledTimes(2);
    expect(sync.lastHeight).toBe(2);

    await advanceTimeAndFlush(3100);
    // Extra flushes to ensure the async operation completes
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSyncState).toHaveBeenCalledTimes(3);
    expect(sync.lastHeight).toBe(3);
  });

  it('should not start a new sync loop if state was already set', async () => {
    // First update with Ready status starts sync
    sync.updateState({ status: WalletStatus.Ready } as any);

    await advanceTimeAndFlush(100);
    const callCountAfterFirstUpdate = mockSyncState.mock.calls.length;
    expect(callCountAfterFirstUpdate).toBe(1);

    // Second update with same status should not start another loop
    sync.updateState({ status: WalletStatus.Ready } as any);

    // Sync interval is 3 seconds
    await advanceTimeAndFlush(3100);

    expect(mockSyncState.mock.calls.length).toBe(2);
  });

  it('should not spawn a second sync loop on repeated sync() calls', async () => {
    sync.updateState({ status: WalletStatus.Ready } as any);

    await advanceTimeAndFlush(100);
    expect(mockSyncState).toHaveBeenCalledTimes(1);

    // Calling sync() again directly should be a no-op (guard prevents duplicate loop)
    sync.sync();
    sync.sync();

    await advanceTimeAndFlush(3100);

    // Should still only have 2 calls (one initial + one after 3s), not 4+
    expect(mockSyncState).toHaveBeenCalledTimes(2);
  });

  it('should skip syncState on generating-transaction page but resume after navigating away', async () => {
    const urlSpy = jest.spyOn(sync, 'getCurrentUrl').mockReturnValue('http://localhost/generating-transaction');

    sync.updateState({ status: WalletStatus.Ready } as any);

    // Advance past the 3s sleep while on generating-transaction page
    await advanceTimeAndFlush(3500);

    // syncState should NOT have been called while on generating-transaction
    expect(mockSyncState).not.toHaveBeenCalled();
    expect(sync.lastHeight).toBe(0);

    // Navigate away from generating-transaction
    urlSpy.mockReturnValue('http://localhost');

    // Advance past the next 3s sleep — loop should now call syncState
    await advanceTimeAndFlush(3500);

    expect(mockSyncState).toHaveBeenCalled();
    expect(sync.lastHeight).toBe(1);
  });
});
