// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/agglayer-status.test.ts (MIT).
import { agglayerExitTxHashFromDetailsCommitment } from 'lib/agglayer/b2agg/exit-hash';
import { findAgglayerExitDeposit, isAgglayerDepositClaimed, isAgglayerDepositReady } from 'lib/agglayer/status';
import { referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import fixture from './fixtures/synthetic-withdrawal.json';

it('binds the pinned synthetic withdrawal to its note commitment rather than a same-recipient same-amount older claim', async () => {
  const exitHash = agglayerExitTxHashFromDetailsCommitment(fixture.detailsCommitment);
  const current = fixture.deposits.find(item => item.deposit_cnt === 42);
  const old = fixture.deposits.find(item => item.deposit_cnt === 41);
  const recovery = selectAgglayerRecoveryConfig(referenceSnapshot('mainnet'), 1);
  if (!current || !old || !recovery) throw new Error('Missing pinned synthetic exit fixture');
  expect(exitHash).toBe('0x7eb49963fd9a3a7d774af18ecdb4ddd7c66dd83d18bcb3c9e9548195644628ab');
  expect(current.tx_hash).toBe(exitHash);
  expect(current.dest_addr).toBe(old.dest_addr);
  expect(current.amount).toBe(old.amount);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const fetcher = jest.fn();
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetcher });
  try {
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ deposits: [old], total_cnt: '1' }) });
    expect(await findAgglayerExitDeposit(current.dest_addr, exitHash, undefined, recovery)).toBeNull();
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ deposits: [current, old], total_cnt: '2' }) });
    expect(await findAgglayerExitDeposit(current.dest_addr, exitHash, undefined, recovery)).toEqual(current);
    expect(isAgglayerDepositReady(current)).toBe(false);
    expect(isAgglayerDepositClaimed(current)).toBe(false);
    expect(isAgglayerDepositClaimed(old)).toBe(true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
    else Reflect.deleteProperty(globalThis, 'fetch');
  }
});
