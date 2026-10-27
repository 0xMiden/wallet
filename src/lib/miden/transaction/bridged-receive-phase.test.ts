import { BridgedReceiveTransaction, IBridgedReceiveExtraInputs, IBridgedReceivePhase } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { revertedExecuteLeg, stalledExecuteLeg } from 'lib/usdcx/cctp';

import { updateBridgedReceivePhase } from './complete';

jest.mock('lib/miden/recovery/receipt-writer', () => ({ checkpointProviderReceipt: jest.fn(async () => {}) }));

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

  // A cause can carry the wallet's message, an address or an amount: only the row's crash report reads it.
  it('never stores what its writer said failed the row', async () => {
    const id = await seed('submitting');

    await updateBridgedReceivePhase(id, 'failed', {
      error: 'User rejected the request.',
      failure: { step: 'wallet_deposit', cause: new Error(`refused for 0x${'ab'.repeat(20)}`) }
    });

    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs.phase).toBe('failed');
    expect(row?.error).toBe('User rejected the request.');
    expect(Object.keys(row?.extraInputs ?? {})).not.toContain('failure');
  });

  it('accepts a write at the same phase, so the deposit screen can add the hash', async () => {
    const id = await seed('submitting');

    await updateBridgedReceivePhase(id, 'submitting', { evmTxHash: '0xhash' });

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({ phase: 'submitting', evmTxHash: '0xhash' });
  });

  // The reconciler matches Circle's attestation to the recipient the deposit signed, written at its first phase write.
  it('keeps the signed USDCx recipient through every later phase write', async () => {
    const recipient = `0x${'0'.repeat(32)}8da911727d5b53916f2c221c00c09100`;
    const id = await seed('submitting');

    await updateBridgedReceivePhase(id, 'submitting', { usdcxRemoteRecipient: recipient });
    await updateBridgedReceivePhase(id, 'delivering', { evmTxHash: '0xhash' });
    await updateBridgedReceivePhase(id, 'ready');

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({
      phase: 'ready',
      evmTxHash: '0xhash',
      usdcxRemoteRecipient: recipient
    });
  });
});

// A row that times out keeps saying it was once attested, which is what lets a late mint still land it.
describe('updateBridgedReceivePhase readyAt', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
  });
  afterEach(() => nowSpy.mockRestore());

  it('stamps the first ready write in seconds and never moves it', async () => {
    const id = await seed('delivering');

    await updateBridgedReceivePhase(id, 'ready');
    nowSpy.mockReturnValue(2_000_000_000);
    await updateBridgedReceivePhase(id, 'ready');
    await updateBridgedReceivePhase(id, 'failed', { error: 'Bridge delivery timed out.' });

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({ phase: 'failed', readyAt: 1_000_000 });
  });

  it('stamps a ready row from before the stamp when it moves on', async () => {
    const id = await seed('ready');

    await updateBridgedReceivePhase(id, 'failed', { error: 'Bridge delivery timed out.' });

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({ phase: 'failed', readyAt: 1_000_000 });
  });

  it('never stamps a row that was not ready', async () => {
    const id = await seed('delivering');

    await updateBridgedReceivePhase(id, 'failed', { error: 'Bridge delivery timed out.' });
    await updateBridgedReceivePhase(id, 'ready');

    expect((await Repo.transactions.get(id))?.extraInputs.readyAt).toBeUndefined();
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

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({
      ...held,
      executeTxHash: H1,
      executeSubmission: 'known',
      executeSavedAt: expect.any(Number)
    });
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

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({
      ...held,
      executeTxHash: H1,
      executeSubmission: 'known',
      executeSavedAt: expect.any(Number)
    });
  });

  it('accepts the same execute hash written again', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H1 } });

    await updateBridgedReceivePhase(id, 'delivering', {
      cctp: { sourceDomain: 6, executeTxHash: H1, forwardState: 'COMPLETE' }
    });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({
      ...held,
      executeTxHash: H1,
      executeSubmission: 'known',
      forwardState: 'COMPLETE'
    });
  });

  // The stall window runs from when the current hash was saved, whichever side saved it.
  it('stamps the time an execute hash is saved, and only when the hash changes', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
    try {
      const id = await seed('delivering', { cctp: held });

      await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H1 } });
      nowSpy.mockReturnValue(2_000_000_000);
      await updateBridgedReceivePhase(id, 'delivering', {
        cctp: { sourceDomain: 6, executeTxHash: H1, forwardState: 'COMPLETE' }
      });
      expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeSavedAt).toBe(1_000_000);

      await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H2 } });
      expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeSavedAt).toBe(2_000_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // A revert drops the message that kept the leg from timing out, so the reconciler counts its week from the revert.
  it('stamps the time a revert reopens the leg', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
    try {
      const id = await seed('delivering', { cctp: { ...held, executeTxHash: H1, executeSavedAt: 5 } });

      await updateBridgedReceivePhase(id, 'delivering', { cctp: revertedExecuteLeg(6, H1) });

      expect((await Repo.transactions.get(id))?.extraInputs.cctp?.revertedAt).toBe(1_000_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reopens a stalled execute keeping its message and proof, and remembers the hash', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H1, executeSavedAt: 5 } });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: stalledExecuteLeg(6, H1) });

    const cctp = (await Repo.transactions.get(id))?.extraInputs.cctp;
    expect(cctp).toMatchObject({ ...held, stalledExecuteTxHash: H1 });
    expect(cctp?.executeTxHash).toBeUndefined();
    expect(cctp?.executeSavedAt).toBeUndefined();
  });

  it('keeps a newer execute hash saved after the stall was observed', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H2 } });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: stalledExecuteLeg(6, H1) });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H2 });
  });

  it('keeps a newer execute hash saved after the revert was observed', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H2 } });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: revertedExecuteLeg(6, H1) });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H2 });
  });
});
