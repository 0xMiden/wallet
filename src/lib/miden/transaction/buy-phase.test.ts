import { BUY_PHASES, BuyTransaction, IBuyExtraInputs, IBuyPhase, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { updateBuyPhase } from './complete';

const seed = async (phase: IBuyPhase, extra: Partial<IBuyExtraInputs> = {}) => {
  const row = new BuyTransaction('account', { orderId: 'order-1', fiatAmount: '50', tokenSymbol: 'TRNSK' });
  row.extraInputs = { ...row.extraInputs, phase, ...extra };
  await Repo.transactions.add(row);
  return row.id;
};

const readInputs = async (id: string): Promise<IBuyExtraInputs | undefined> =>
  (await Repo.transactions.get(id))?.extraInputs;

beforeEach(async () => {
  await Repo.transactions.clear();
});

describe('BuyTransaction', () => {
  it('is born completed in the payment phase, so the FIFO loop never picks it up', () => {
    const row = new BuyTransaction('account', { orderId: 'order-1', fiatAmount: '50', tokenSymbol: 'TRNSK' });
    expect(row.type).toBe('buy');
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.extraInputs).toMatchObject({
      orderId: 'order-1',
      provider: 'transak',
      fiatCurrency: 'USD',
      phase: 'payment'
    });
    expect(row.extraInputs.phaseTimestamps.payment).toEqual(expect.any(Number));
  });
});

describe('updateBuyPhase', () => {
  it('moves forward, stamps each new phase once and merges the patch', async () => {
    const id = await seed('payment');
    const now = jest.spyOn(Date, 'now');

    now.mockReturnValue(1_000);
    await updateBuyPhase(id, 'funds-arriving', { tokenAmount: '5', tokenDecimals: 18 });
    now.mockReturnValue(2_000);
    await updateBuyPhase(id, 'funds-arriving', { relayTxHash: '0xhash' });
    now.mockReturnValue(3_000);
    await updateBuyPhase(id, 'bridge-sent');
    now.mockRestore();

    expect(await readInputs(id)).toMatchObject({
      phase: 'bridge-sent',
      tokenAmount: '5',
      tokenDecimals: 18,
      relayTxHash: '0xhash',
      phaseTimestamps: { 'funds-arriving': 1_000, 'bridge-sent': 3_000 }
    });
  });

  const earlierThanBridging: IBuyPhase[] = ['payment', 'funds-arriving', 'bridge-sent'];
  it.each(earlierThanBridging)('never moves a bridging row back to %s', async earlier => {
    const id = await seed('bridging');

    await updateBuyPhase(id, earlier, { error: 'stale write' });

    expect(await readInputs(id)).toMatchObject({ phase: 'bridging' });
    expect((await readInputs(id))?.error).toBeUndefined();
  });

  it.each(BUY_PHASES.slice(0, -1))('lets a %s row fail, with its error on the row', async phase => {
    const id = await seed(phase);

    await updateBuyPhase(id, 'failed', { error: 'Order expired' });

    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs.phase).toBe('failed');
    expect(row?.error).toBe('Order expired');
  });

  it('keeps a completed row completed', async () => {
    const id = await seed('completed');

    await updateBuyPhase(id, 'failed', { error: 'late failure' });
    await updateBuyPhase(id, 'consuming');

    expect(await readInputs(id)).toMatchObject({ phase: 'completed' });
  });

  it('lets a failed row complete when the note is consumed after all, and nothing else', async () => {
    const id = await seed('failed');

    await updateBuyPhase(id, 'bridging');
    expect(await readInputs(id)).toMatchObject({ phase: 'failed' });

    await updateBuyPhase(id, 'completed', { consumeTxId: 'consume-1' });
    expect(await readInputs(id)).toMatchObject({ phase: 'completed', consumeTxId: 'consume-1' });
  });

  it('does not touch a row of another type', async () => {
    await Repo.transactions.add({
      id: 'other',
      type: 'send',
      accountId: 'account',
      status: ITransactionStatus.Completed,
      initiatedAt: 0,
      displayIcon: 'SEND',
      extraInputs: { phase: 'payment' }
    });

    await updateBuyPhase('other', 'completed');

    expect((await Repo.transactions.get('other'))?.extraInputs).toEqual({ phase: 'payment' });
  });
});
