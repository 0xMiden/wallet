import { BuyTransaction, ConsumeTransaction, IBuyExtraInputs, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { applyBridgeInToConsumeRow, suppressedLinkedConsumeIds, takeBuyBridgeInInfo } from './bridge-in';
import { NoteTypeEnum } from '../types';

const ACCOUNT = 'mtst1account';
const AMOUNT = 5n * 10n ** 18n;

async function seedBuy(extra: Partial<IBuyExtraInputs>): Promise<string> {
  const row = new BuyTransaction(ACCOUNT, { orderId: 'order-1', fiatAmount: '5', tokenSymbol: 'TRNSK' });
  row.extraInputs = { ...row.extraInputs, ...extra };
  await Repo.transactions.add(row);
  return row.id;
}

beforeEach(async () => {
  await Repo.transactions.clear();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buy bridge-in', () => {
  it('matches a consumed note to an open buy row by account and amount', async () => {
    const id = await seedBuy({ phase: 'bridging', tokenAmount: AMOUNT.toString(), relayTxHash: '0xrelay' });

    const info = await takeBuyBridgeInInfo({ accountId: ACCOUNT, faucetId: 'mtst1faucet', amount: AMOUNT });
    expect(info).toEqual({
      provider: 'agglayer',
      sourceAmount: '5',
      sourceSymbol: 'TRNSK',
      evmTxHash: '0xrelay',
      buyTxId: id
    });
    await expect(takeBuyBridgeInInfo({ accountId: ACCOUNT, faucetId: 'mtst1faucet', amount: 1n })).resolves.toBe(
      undefined
    );
    await expect(
      takeBuyBridgeInInfo({ accountId: 'mtst1other', faucetId: 'mtst1faucet', amount: AMOUNT })
    ).resolves.toBe(undefined);
  });

  it('completes the buy row when its consume completes, and hides that consume in history', async () => {
    const buyId = await seedBuy({ phase: 'consuming', tokenAmount: AMOUNT.toString() });
    const consume = new ConsumeTransaction(ACCOUNT, [
      {
        id: 'note-1',
        faucetId: 'mtst1faucet',
        amount: AMOUNT.toString(),
        senderAddress: '',
        isBeingClaimed: false,
        type: NoteTypeEnum.Public
      }
    ]);
    consume.status = ITransactionStatus.Completed;
    await Repo.transactions.add(consume);

    await applyBridgeInToConsumeRow(consume.id, { provider: 'agglayer', buyTxId: buyId, midenNoteId: 'note-1' });

    const buy = await Repo.transactions.get(buyId);
    expect(buy?.extraInputs).toMatchObject({ phase: 'completed', consumeTxId: consume.id, midenNoteId: 'note-1' });
    const rows = await Repo.transactions.toArray();
    expect(await suppressedLinkedConsumeIds(rows)).toEqual(new Set([consume.id]));
  });
});
