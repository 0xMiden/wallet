import '../../../../test/jest-mocks';

import { __resetSyncFuseStateForTests } from 'lib/miden/front/sync-fuse';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';

import { fetchBalances } from './fetchBalances';

// The real mutex is the subject here: these tests are about WHEN the balance read gets
// the lock relative to other holds, which a stubbed lock cannot show.
const mockGetAccount = jest.fn();
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: { getAccount: (...args: unknown[]) => mockGetAccount(...args) }
}));

jest.mock('lib/miden/assets', () => ({
  getFaucetIdSetting: jest.fn(async () => 'miden-faucet-id')
}));

jest.mock('../../miden/front/assets', () => ({
  setTokensBaseMetadata: jest.fn()
}));

// jest-mocks.ts blanket-mocks lib/miden/sdk/miden-client (a manual stub that just runs the
// operation with no real queueing) for every other suite. These tests are about lock
// ORDERING, which only the real mutex can show, so this file needs the genuine module --
// and `fetchBalances`'s own import of it must resolve to that SAME singleton mutex. A
// factory mock wins that regardless of load order: jest-runtime's `_requireMockWithId`
// consults a registered factory before falling back to the automock jest-mocks.ts asks
// for, so this file's own factory (`jest.requireActual`) is what both this file and
// `fetchBalances` resolve to.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireActual('lib/miden/sdk/miden-client'));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('fetchBalances and the WASM lock', () => {
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  beforeEach(() => {
    mockGetAccount.mockReset();
    mockGetAccount.mockResolvedValue(null);
    __resetSyncFuseStateForTests();
  });

  it('waits behind a held lock and reads once it is released, instead of skipping (#1123)', async () => {
    let release!: () => void;
    const holder = withWasmClientLock(() => new Promise<void>(resolve => (release = resolve)), {
      label: 'test-holder'
    });

    const read = fetchBalances('my-address', {}, { waitForLock: true });
    await flush();
    expect(mockGetAccount).not.toHaveBeenCalled();

    release();
    await holder;
    const balances = await read;

    expect(mockGetAccount).toHaveBeenCalledWith('my-address');
    expect(balances).toEqual([expect.objectContaining({ tokenId: 'miden-faucet-id', balance: 0 })]);
  });

  it('still skips a held lock when not asked to wait', async () => {
    let release!: () => void;
    const holder = withWasmClientLock(() => new Promise<void>(resolve => (release = resolve)), {
      label: 'test-holder'
    });

    const balances = await fetchBalances('my-address', {});

    release();
    await holder;
    expect(balances).toBeNull();
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('takes a free lock on the call itself, ahead of a hold requested right after it', async () => {
    // The Ready-time read is called before any React effect runs, so it only beats the
    // first sync if it asks for the lock before its first await. A storage read awaited
    // ahead of the lock hands the sync the mutex, and every sync tick after that.
    const order: string[] = [];
    mockGetAccount.mockImplementation(async () => {
      order.push('balance-read');
      return null;
    });

    const read = fetchBalances('my-address', {}, { waitForLock: true });
    const sync = withWasmClientLock(
      async () => {
        order.push('sync');
      },
      { label: 'test-sync' }
    );
    await Promise.all([read, sync]);

    expect(order).toEqual(['balance-read', 'sync']);
  });
});
