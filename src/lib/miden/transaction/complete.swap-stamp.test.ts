import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { completeConsumeTransaction } from './complete';
import { isOpenRecoveredOrder } from '../swap/recovered-order';

jest.mock('../activity/bridge-in', () => ({
  adoptBridgeDeliveries: jest.fn(async () => undefined)
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id
}));

// The reclaim of the account's own order note: 70 offered, sent by the account itself.
function reclaimOfOrderNote(): TransactionResult {
  const result: TransactionResult = Object.create(null);
  Object.assign(result, {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'chain-tx' }),
      inputNotes: () => ({
        notes: () => [
          {
            note: () => ({
              id: () => ({ toString: () => 'order-note' }),
              metadata: () => ({ sender: () => 'account', noteType: () => 0 }),
              assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'offer', amount: () => 70n }] })
            })
          }
        ]
      })
    }),
    serialize: () => new Uint8Array([1])
  });
  return result;
}

const swapOrder = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'swap',
  type: 'swap',
  accountId: 'account',
  status: ITransactionStatus.Completed,
  initiatedAt: 1,
  completedAt: 2,
  displayIcon: 'SWAP',
  faucetId: 'offer',
  amount: 70n,
  outputNoteIds: ['order-note'],
  extraInputs: { orderId: '42', requestedFaucetId: 'requested', requestedAmount: 30n, expiresAt: 5 },
  ...overrides
});

beforeEach(async () => {
  await Repo.transactions.clear();
  await Repo.transactions.add({
    id: 'reclaim',
    type: 'consume',
    accountId: 'account',
    status: ITransactionStatus.GeneratingTransaction,
    displayIcon: 'RECEIVE',
    initiatedAt: 3,
    noteId: 'order-note',
    noteIds: ['order-note'],
    extraInputs: { swapOrderTxId: 'swap', swapSettleKind: 'reclaim' }
  });
});

it("stamps a live order's reclaim on the order once its consume completes", async () => {
  await Repo.transactions.add(swapOrder());

  await completeConsumeTransaction('reclaim', reclaimOfOrderNote());

  expect((await Repo.transactions.get('swap'))?.extraInputs?.reclaimedAt).toEqual(expect.any(Number));
});

const settlementClaim = (
  id: string,
  swapSettleKind: 'settle' | 'reclaim',
  status: ITransactionStatus
): ITransaction => ({
  id,
  type: 'consume',
  accountId: 'account',
  status,
  displayIcon: 'RECEIVE',
  initiatedAt: 3,
  noteId: `${id}-note`,
  noteIds: [`${id}-note`],
  extraInputs: { swapOrderTxId: 'swap', swapSettleKind }
});

// A settlement over the claim cap is several consume rows (#1644); the stamp is the last one's, so a chunk that
// fails leaves the order unstamped and the next tick queues its notes again.
it('stamps a settlement split over several claims only once the last of them completes (#1644)', async () => {
  await Repo.transactions.add(swapOrder());
  await Repo.transactions.add(settlementClaim('reclaim-2', 'reclaim', ITransactionStatus.Queued));

  await completeConsumeTransaction('reclaim', reclaimOfOrderNote());
  expect((await Repo.transactions.get('reclaim'))?.status).toBe(ITransactionStatus.Completed);
  expect((await Repo.transactions.get('swap'))?.extraInputs?.reclaimedAt).toBeUndefined();

  await completeConsumeTransaction('reclaim-2', reclaimOfOrderNote());
  expect((await Repo.transactions.get('swap'))?.extraInputs?.reclaimedAt).toEqual(expect.any(Number));
});

it('a sibling claim awaiting its verdict holds the stamp, one of the other kind or a failed one does not', async () => {
  await Repo.transactions.add(swapOrder());
  await Repo.transactions.add(settlementClaim('settle-1', 'settle', ITransactionStatus.Queued));
  await Repo.transactions.add(settlementClaim('reclaim-failed', 'reclaim', ITransactionStatus.Failed));
  await Repo.transactions.add(settlementClaim('reclaim-unconfirmed', 'reclaim', ITransactionStatus.Unconfirmed));

  await completeConsumeTransaction('reclaim', reclaimOfOrderNote());
  expect((await Repo.transactions.get('swap'))?.extraInputs?.reclaimedAt).toBeUndefined();

  await Repo.transactions.update('reclaim-unconfirmed', { status: ITransactionStatus.Failed });
  await Repo.transactions.update('reclaim', { status: ITransactionStatus.GeneratingTransaction });
  await completeConsumeTransaction('reclaim', reclaimOfOrderNote());
  expect((await Repo.transactions.get('swap'))?.extraInputs?.reclaimedAt).toEqual(expect.any(Number));
});

// A Guardian-recovered order is closed by its lineage on the node once the walk reads finished, which then takes the
// stamp from this consume; stamped here, a cancel of a remainder would close an order a later fill may still own (#1487).
it('leaves the close of a Guardian-recovered order to its lineage when its reclaim completes', async () => {
  await Repo.transactions.add(
    swapOrder({
      restoredFromBackup: true,
      recovered: true,
      recovery: {
        version: 1,
        network: 'testnet',
        operators: ['https://one'],
        nonce: 2,
        inputNotes: [],
        outputNotes: [
          {
            id: 'order-note',
            visibility: 'public',
            assets: [{ faucetId: 'offer', amount: '70' }],
            swap: { orderId: '42', requestedAsset: { faucetId: 'requested', amount: '30' } }
          }
        ],
        completeness: 'decoded',
        reclaimed: false
      },
      extraInputs: {
        orderId: '42',
        requestedFaucetId: 'requested',
        requestedAmount: 30n,
        autoConsume: false,
        expiresAt: 5,
        expiryTriggeredAt: 5
      }
    })
  );

  await completeConsumeTransaction('reclaim', reclaimOfOrderNote());

  const order = await Repo.transactions.get('swap');
  expect((await Repo.transactions.get('reclaim'))?.status).toBe(ITransactionStatus.Completed);
  expect(order?.extraInputs?.reclaimedAt).toBeUndefined();
  expect(order && isOpenRecoveredOrder(order)).toBe(true);
});
