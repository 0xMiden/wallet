import { ISellExtraInputs, ISellPhase, ITransactionStatus, SELL_PHASES, SellTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { updateSellPhase } from './complete';
import { initiateSellTransaction } from './initiate';

const INPUT: ConstructorParameters<typeof SellTransaction>[1] = {
  orderId: 'order-1',
  cryptoAmount: '100',
  tokenSymbol: 'TRNSK',
  tokenDecimals: 8,
  depositAddress: '0x57359A5071a83D3b5640BDcb7Ad17c70F40088A4',
  depositSource: 'event',
  faucetId: 'mtst1trnsk',
  tokenAmount: '10000000000',
  evmAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  bridgeTxId: 'bridge-1'
};

const seed = async (phase: ISellPhase, extra: Partial<ISellExtraInputs> = {}) => {
  const row = new SellTransaction('account', INPUT);
  row.extraInputs = { ...row.extraInputs, phase, ...extra };
  await Repo.transactions.add(row);
  return row.id;
};

const readInputs = async (id: string): Promise<ISellExtraInputs | undefined> =>
  (await Repo.transactions.get(id))?.extraInputs;

beforeEach(async () => {
  await Repo.transactions.clear();
});

describe('SellTransaction', () => {
  it('is born completed in the submitting phase, with no amount of its own, so no loop or sum picks it up', () => {
    const row = new SellTransaction('account', INPUT);
    expect(row.type).toBe('sell');
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row).not.toHaveProperty('amount');
    expect(row).not.toHaveProperty('faucetId');
    expect(row).not.toHaveProperty('requestBytes');
    expect(row.extraInputs).toMatchObject({ ...INPUT, provider: 'transak', phase: 'submitting' });
    expect(row.extraInputs.phaseTimestamps.submitting).toEqual(expect.any(Number));
  });
});

describe('initiateSellTransaction', () => {
  it('makes one row for each backend order of an account', async () => {
    const first = await initiateSellTransaction('account', INPUT);
    const second = await initiateSellTransaction('account', { ...INPUT, bridgeTxId: 'bridge-2' });
    expect(second).toBe(first);
    expect(await Repo.transactions.count()).toBe(1);
    expect(await readInputs(first)).toMatchObject({ bridgeTxId: 'bridge-1' });

    const other = await initiateSellTransaction('account', { ...INPUT, orderId: 'order-2' });
    expect(other).not.toBe(first);
  });
});

describe('updateSellPhase', () => {
  it('moves forward, stamps each new phase once and merges the patch', async () => {
    const id = await seed('submitting');
    const now = jest.spyOn(Date, 'now');

    now.mockReturnValue(1_000);
    await updateSellPhase(id, 'bridging', { bridgeTransactionId: '0xmiden' });
    now.mockReturnValue(2_000);
    await updateSellPhase(id, 'bridging', { transakStatus: 'AWAITING_PAYMENT_FROM_USER' });
    now.mockReturnValue(3_000);
    await updateSellPhase(id, 'sent', { relayTxHash: '0xhash' });
    now.mockRestore();

    expect(await readInputs(id)).toMatchObject({
      phase: 'sent',
      bridgeTransactionId: '0xmiden',
      transakStatus: 'AWAITING_PAYMENT_FROM_USER',
      relayTxHash: '0xhash',
      phaseTimestamps: { bridging: 1_000, sent: 3_000 }
    });
  });

  const earlierThanSent = SELL_PHASES.slice(0, SELL_PHASES.indexOf('sent'));
  it.each(earlierThanSent)('never moves a sent row back to %s', async earlier => {
    const id = await seed('sent');
    await updateSellPhase(id, earlier, { transakStatus: 'stale' });
    expect(await readInputs(id)).toMatchObject({ phase: 'sent' });
    expect((await readInputs(id))?.transakStatus).toBeUndefined();
  });

  it('fails a row from any open phase, with the cause and the detail', async () => {
    const id = await seed('bridging');
    await updateSellPhase(id, 'failed', { failure: 'order-expired', error: 'Transak expired the order' });
    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs).toMatchObject({ phase: 'failed', failure: 'order-expired' });
    expect(row?.error).toBe('Transak expired the order');
    expect(row?.displayMessage).toBe('Sale failed');
    // The row status does not change: the row is never in the transaction queue.
    expect(row?.status).toBe(ITransactionStatus.Completed);
  });

  it('keeps a completed row, and lets only a payout follow a failure', async () => {
    const done = await seed('completed');
    await updateSellPhase(done, 'failed', { failure: 'timeout' });
    expect(await readInputs(done)).toMatchObject({ phase: 'completed' });

    const failed = await seed('failed', { failure: 'timeout' });
    await updateSellPhase(failed, 'sent');
    expect(await readInputs(failed)).toMatchObject({ phase: 'failed' });
    await updateSellPhase(failed, 'completed');
    expect(await readInputs(failed)).toMatchObject({ phase: 'completed' });
  });

  it('does not write to a row of another type', async () => {
    const id = await seed('submitting');
    await Repo.transactions.where({ id }).modify({ type: 'buy' });
    await updateSellPhase(id, 'sent');
    expect(await readInputs(id)).toMatchObject({ phase: 'submitting' });
  });
});
