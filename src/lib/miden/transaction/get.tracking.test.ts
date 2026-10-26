import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { __resetSyncFuseStateForTests, noteSyncWatchdogEviction } from 'lib/miden/front/sync-fuse';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';

import { trackSwapOrders } from './get';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  PswapLineageState: { Active: 0, FullyFilled: 1, Reclaimed: 2 }
}));
jest.mock('lib/miden/repo', () => ({}));
jest.mock('../activity/utils', () => ({ compareAccountIds: jest.fn() }));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: { getPswapLineages: jest.fn() } }));

let mockCurrentHold: object | null = null;
let mockOnAcquired: (() => void) | null = null;
const mockLockOptions: unknown[] = [];
jest.mock('../sdk/miden-client', () => ({
  assertWasmHoldCurrent: (hold: object) => {
    if (hold !== mockCurrentHold) throw new Error('abandoned hold');
  },
  withWasmClientLock: async <T>(operation: (hold: object) => Promise<T>, options: unknown): Promise<T> => {
    mockLockOptions.push(options);
    const hold = {};
    mockCurrentHold = hold;
    mockOnAcquired?.();
    try {
      return await operation(hold);
    } finally {
      if (mockCurrentHold === hold) mockCurrentHold = null;
    }
  }
}));

const lineages = jest.mocked(midenClientProxy.getPswapLineages);

beforeEach(() => {
  jest.clearAllMocks();
  mockOnAcquired = null;
  mockLockOptions.length = 0;
  __resetSyncFuseStateForTests();
  lineages.mockResolvedValue([]);
});

afterEach(() => {
  __resetSyncFuseStateForTests();
});

it('tracks every lineage from one bounded read while preserving amounts above Number precision', async () => {
  lineages.mockResolvedValue([
    {
      orderId: '77',
      currentTipNoteId: 'tip77',
      currentDepth: 2,
      state: 1,
      remainingOffered: '9007199254740993',
      remainingRequested: '18446744073709551615'
    },
    {
      orderId: '88',
      currentTipNoteId: 'tip88',
      currentDepth: 1,
      state: 2,
      remainingOffered: '10',
      remainingRequested: '20'
    },
    {
      orderId: '99',
      currentTipNoteId: 'tip99',
      currentDepth: 0,
      state: 0,
      remainingOffered: '30',
      remainingRequested: '40'
    }
  ]);
  const result = await trackSwapOrders();
  expect(result).toEqual(
    new Map([
      [
        '77',
        {
          orderId: '77',
          state: 'filled',
          currentDepth: 2,
          remainingOffered: 9007199254740993n,
          remainingRequested: 18446744073709551615n
        }
      ],
      ['88', { orderId: '88', state: 'reclaimed', currentDepth: 1, remainingOffered: 10n, remainingRequested: 20n }],
      ['99', { orderId: '99', state: 'active', currentDepth: 0, remainingOffered: 30n, remainingRequested: 40n }]
    ])
  );
  expect(lineages).toHaveBeenCalledTimes(1);
  expect(mockLockOptions).toEqual([{ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'swap-order-tracking' }]);
});

it('returns an empty map for a successful snapshot with no orders', async () => {
  expect(await trackSwapOrders()).toEqual(new Map());
});

it('propagates a failed snapshot so the manager can report the failed probe', async () => {
  lineages.mockRejectedValue(new Error('snapshot failed'));
  await expect(trackSwapOrders()).rejects.toThrow('snapshot failed');
});

it('skips a read whose fuse lights while waiting for the lock', async () => {
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockOnAcquired = () => {
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('swap-order-tracking');
  };
  expect(await trackSwapOrders()).toBeNull();
  expect(lineages).not.toHaveBeenCalled();
  warning.mockRestore();
});

it('binds the proxy liveness check to the captured hold', async () => {
  lineages.mockImplementation(async assertLive => {
    mockCurrentHold = {};
    assertLive();
    return [];
  });
  await expect(trackSwapOrders()).rejects.toThrow('abandoned hold');
});
