import { BridgedReceiveTransaction, IBridgedReceiveExtraInputs, IBridgedReceivePhase } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { revertedExecuteLeg } from 'lib/usdcx/cctp';

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

// The executor route writes its CCTP leg a field at a time, and a reopen after a reverted Arc execute clears the
// hash it saw revert. Run against the real writer: every consumer suite mocks it.
describe('updateBridgedReceivePhase on a USDCx CCTP leg', () => {
  const H1 = `0x${'1'.repeat(64)}`;
  const H2 = `0x${'2'.repeat(64)}`;
  const held = { sourceDomain: 6, forwarded: true, forwardFee: '31908', message: '0x1234', attestation: '0xabcd' };

  it('keeps the message, the proof and the forward when the execute hash is saved', async () => {
    const id = await seed('delivering', { cctp: held });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H1 } });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H1 });
  });

  it('reopens the execute it saw revert, clearing its hash and proof', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H1 } });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: revertedExecuteLeg(6, H1) });

    const cctp = (await Repo.transactions.get(id))?.extraInputs.cctp;
    expect(cctp).toMatchObject({ sourceDomain: 6, forwarded: false, forwardFee: '31908', revertedExecuteTxHash: H1 });
    expect(cctp?.executeTxHash).toBeUndefined();
    expect(cctp?.message).toBeUndefined();
    expect(cctp?.attestation).toBeUndefined();
  });

  // A late Iris answer adopting Circle's forward must not replace a manual execute the wallet saved meanwhile.
  it('keeps a manual execute hash a late forward adoption would replace', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H2 } });

    await updateBridgedReceivePhase(
      id,
      'delivering',
      { cctp: { sourceDomain: 6, executeTxHash: H1, forwardState: 'COMPLETE' } },
      undefined,
      { onlyIfNoExecuteHash: true }
    );

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H2 });
  });

  // The wallet's own execute may land after an adoption during its signing window; it replaces the adopted hash, and
  // the reconciler reopens on whichever held hash reverts.
  it('lets a manual execute replace an adopted forward hash', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H2 } });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H1 } });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H1 });
  });

  it('accepts the same execute hash written again', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H1 } });

    await updateBridgedReceivePhase(id, 'delivering', {
      cctp: { sourceDomain: 6, executeTxHash: H1, forwardState: 'COMPLETE' }
    });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({
      ...held,
      executeTxHash: H1,
      forwardState: 'COMPLETE'
    });
  });

  it('keeps a newer execute hash saved after the revert was observed', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H2 } });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: revertedExecuteLeg(6, H1) });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H2 });
  });
});
