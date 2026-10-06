import { captureNativeAssetSnapshot, recordSyncedFeeFaucetId } from 'lib/miden-chain/native-asset';

import { assertWasmHoldCurrent } from './miden-client';
import { bindFeeFaucetClientScope, syncAndRecordFeeFaucet } from './sync-and-record-fee-faucet';

jest.mock('lib/miden-chain/native-asset', () => ({
  cacheScope: () => 'current-rpc|devnet',
  captureNativeAssetSnapshot: jest.fn((scope: string) => ({ scope, revision: 4 })),
  recordSyncedFeeFaucetId: jest.fn(async () => true)
}));
jest.mock('./miden-client', () => ({
  getCurrentWasmLockHold: () => ({ generation: 1 }),
  assertWasmHoldCurrent: jest.fn()
}));

beforeEach(() => jest.clearAllMocks());

it('keeps the construction scope and returns the original full-sync summary', async () => {
  const client = { feeFaucetId: jest.fn(async () => ({ toString: () => '0xfee' })) };
  bindFeeFaucetClientScope(client, 'original-rpc|testnet');
  bindFeeFaucetClientScope(client, 'replacement-rpc|devnet');
  const summary = { blockNum: () => 12 };
  const sync = jest.fn(async () => summary);
  await expect(syncAndRecordFeeFaucet(client, sync)).resolves.toBe(summary);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(client.feeFaucetId).toHaveBeenCalledTimes(1);
  expect(captureNativeAssetSnapshot).toHaveBeenCalledWith('original-rpc|testnet');
  expect(recordSyncedFeeFaucetId).toHaveBeenCalledWith(
    '0xfee',
    { scope: 'original-rpc|testnet', revision: 4 },
    expect.any(Function)
  );
});

it('does not touch the fee accessor after the sync lost its hold', async () => {
  const client = { feeFaucetId: jest.fn(async () => ({ toString: () => '0xfee' })) };
  bindFeeFaucetClientScope(client);
  const abandoned = new Error('hold replaced');
  jest
    .mocked(assertWasmHoldCurrent)
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw abandoned;
    });
  await expect(syncAndRecordFeeFaucet(client, async () => 12)).rejects.toBe(abandoned);
  expect(client.feeFaucetId).not.toHaveBeenCalled();
  expect(recordSyncedFeeFaucetId).not.toHaveBeenCalled();
});

it('does not publish an accessor response after client disposal while it awaited', async () => {
  let release: () => void = () => undefined;
  let live = true;
  const client = {
    feeFaucetId: jest.fn(
      () =>
        new Promise<{ toString(): string }>(resolve => {
          release = () => resolve({ toString: () => '0xfee' });
        })
    )
  };
  bindFeeFaucetClientScope(client);
  const result = syncAndRecordFeeFaucet(
    client,
    async () => 12,
    () => {
      if (!live) throw new Error('disposed');
    }
  );
  await Promise.resolve();
  live = false;
  release();
  await expect(result).rejects.toThrow('disposed');
  expect(recordSyncedFeeFaucetId).not.toHaveBeenCalled();
});

it('propagates facade traps without publishing an identity', async () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  const client = {
    feeFaucetId: jest.fn(async () => {
      throw trap;
    })
  };
  bindFeeFaucetClientScope(client);
  await expect(syncAndRecordFeeFaucet(client, async () => 12)).rejects.toBe(trap);
  expect(recordSyncedFeeFaucetId).not.toHaveBeenCalled();
});
