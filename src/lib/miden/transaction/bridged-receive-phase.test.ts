import { BridgedReceiveTransaction, IBridgedReceiveExtraInputs, IBridgedReceivePhase } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { updateBridgedReceivePhase } from './complete';

const seed = async (phase: IBridgedReceivePhase, extra: Partial<IBridgedReceiveExtraInputs> = {}) => {
  const row = new BridgedReceiveTransaction('account', 5n, '', 'agglayer', '0xsource', '5', 'ETH');
  row.extraInputs = { ...row.extraInputs, phase, ...extra };
  await Repo.transactions.add(row);
  return row.id;
};

beforeEach(async () => {
  await Repo.transactions.clear();
});

// Writers read a row, await the network or a wallet, then write, so a write can
// arrive after the row moved on. The stored phase must never go backwards.
describe('updateBridgedReceivePhase', () => {
  it.each(['ready', 'delivering', 'submitting', 'failed'] as const)(
    'keeps a received row received, with its delivered asset, under a later %s write',
    async later => {
      const id = await seed('submitting');
      await updateBridgedReceivePhase(id, 'received', {}, { amount: 7n, faucetId: 'delivered-faucet' });

      await updateBridgedReceivePhase(id, later, { error: 'stale write' }, { amount: 1n, faucetId: 'other-faucet' });

      const row = await Repo.transactions.get(id);
      expect(row?.extraInputs.phase).toBe('received');
      expect(row?.amount).toBe(7n);
      expect(row?.faucetId).toBe('delivered-faucet');
      expect(row?.error).toBeUndefined();
    }
  );

  it('lets a failed row become received once the funds arrive, and nothing else', async () => {
    const id = await seed('failed');

    await updateBridgedReceivePhase(id, 'delivering');
    expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('failed');

    await updateBridgedReceivePhase(id, 'received', {}, { amount: 5n, faucetId: 'delivered-faucet' });
    expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('received');
  });

  it('never moves a ready row back to delivering, but still lets it fail', async () => {
    const id = await seed('ready');

    await updateBridgedReceivePhase(id, 'delivering');
    expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('ready');

    await updateBridgedReceivePhase(id, 'failed', { error: 'Bridge delivery timed out.' });
    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs.phase).toBe('failed');
    expect(row?.error).toBe('Bridge delivery timed out.');
  });

  it('accepts a write at the same phase, so the deposit screen can add the hash', async () => {
    const id = await seed('submitting');

    await updateBridgedReceivePhase(id, 'submitting', { evmTxHash: '0xhash' });

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({ phase: 'submitting', evmTxHash: '0xhash' });
  });
});
