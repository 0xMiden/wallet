import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import type { GuardianHistoryNote } from 'lib/miden/sdk/guardian-history';

import {
  isOpenRecoveredOrder,
  isRecoveredReturnOrder,
  recoveredOrderNoteId,
  recoveredSwapOrderRef
} from './recovered-order';

const orderNote = (id: string, orderId = '42'): GuardianHistoryNote => ({
  id,
  assets: [{ faucetId: 'offered', amount: '70' }],
  visibility: 'public',
  sender: 'account',
  swap: { orderId, requestedAsset: { faucetId: 'requested', amount: '30' } }
});

const recoveredSwap = (overrides: Partial<ITransaction> = {}, extra: Record<string, unknown> = {}): ITransaction => ({
  id: 'guardian-history:testnet:account:0xcommitment',
  type: 'swap',
  accountId: 'account',
  status: ITransactionStatus.Completed,
  initiatedAt: 100,
  completedAt: 100,
  displayIcon: 'DEFAULT',
  amount: 70n,
  faucetId: 'offered',
  outputNoteIds: ['order-note'],
  restoredFromBackup: true,
  recovered: true,
  recovery: {
    version: 5,
    network: 'testnet',
    operators: ['https://guardian.example'],
    nonce: 2,
    inputNotes: [],
    outputNotes: [orderNote('order-note')],
    completeness: 'decoded',
    reclaimed: false
  },
  extraInputs: { orderId: '42', requestedFaucetId: 'requested', requestedAmount: 30n, autoConsume: false, ...extra },
  ...overrides
});

const withOutputNotes = (notes: GuardianHistoryNote[], outputNoteIds: string[]): ITransaction => {
  const row = recoveredSwap();
  return { ...row, outputNoteIds, recovery: row.recovery && { ...row.recovery, outputNotes: notes } };
};

describe('recoveredOrderNoteId', () => {
  it("names the one output note whose summary carries the row's order id and a requested asset", () => {
    expect(recoveredOrderNoteId(recoveredSwap())).toBe('order-note');
  });

  it('skips a payback-shaped note of the same order, which carries no requested asset', () => {
    const payback: GuardianHistoryNote = { ...orderNote('payback'), swap: { orderId: '42' } };
    expect(recoveredOrderNoteId(withOutputNotes([payback, orderNote('order-note')], ['payback', 'order-note']))).toBe(
      'order-note'
    );
  });

  it.each([
    ['two notes claim the order', withOutputNotes([orderNote('a'), orderNote('b')], ['a', 'b'])],
    ['the note is not one of the row’s output notes', withOutputNotes([orderNote('order-note')], ['another-note'])],
    ['the note belongs to another order', withOutputNotes([orderNote('order-note', '43')], ['order-note'])],
    ['the row carries no recovery data', { ...recoveredSwap(), recovery: undefined }],
    ['the row carries no order id', recoveredSwap({}, { orderId: undefined })],
    ['the row is not a swap', recoveredSwap({ type: 'consume' })]
  ])('names none when %s', (_label, row) => {
    expect(recoveredOrderNoteId(row)).toBeUndefined();
  });

  it('matches a bigint order id by its decimal form', () => {
    expect(recoveredOrderNoteId(recoveredSwap({}, { orderId: 42n }))).toBe('order-note');
  });
});

describe('isOpenRecoveredOrder', () => {
  it('holds for a recovered, completed order with its order note and amounts and no closing stamp', () => {
    expect(isOpenRecoveredOrder(recoveredSwap())).toBe(true);
  });

  it.each([
    ['a local row', recoveredSwap({ recovered: undefined, restoredFromBackup: undefined })],
    ['a row restored from a backup file only', recoveredSwap({ recovered: undefined })],
    ['a failed row', recoveredSwap({ status: ITransactionStatus.Failed })],
    ['a settled order', recoveredSwap({}, { settledAt: 200 })],
    ['a reclaimed order', recoveredSwap({}, { reclaimedAt: 200 })],
    ['an order whose note the node showed spent', recoveredSwap({}, { orderNoteSpentAt: 200 })],
    ['an order with no offered amount', recoveredSwap({ amount: undefined })],
    ['an order with no requested amount', recoveredSwap({}, { requestedAmount: undefined })],
    ['an order with no order note', withOutputNotes([], [])]
  ])('does not hold for %s', (_label, row) => {
    expect(isOpenRecoveredOrder(row)).toBe(false);
  });
});

describe('isRecoveredReturnOrder', () => {
  it("holds only once this wallet's Cancel stamped the open order", () => {
    expect(isRecoveredReturnOrder(recoveredSwap())).toBe(false);
    expect(isRecoveredReturnOrder(recoveredSwap({}, { expiresAt: 150, expiryTriggeredAt: 150 }))).toBe(true);
  });

  it('does not hold for a stamped order that has since closed', () => {
    expect(isRecoveredReturnOrder(recoveredSwap({}, { expiryTriggeredAt: 150, reclaimedAt: 200 }))).toBe(false);
    expect(isRecoveredReturnOrder(recoveredSwap({}, { expiryTriggeredAt: 150, orderNoteSpentAt: 200 }))).toBe(false);
  });
});

describe('recoveredSwapOrderRef', () => {
  it('carries what the node read and the depth-0 lineage need', () => {
    expect(recoveredSwapOrderRef(recoveredSwap({}, { orderId: 42n }))).toEqual({
      txId: 'guardian-history:testnet:account:0xcommitment',
      accountId: 'account',
      orderId: '42',
      noteId: 'order-note',
      offeredAmount: 70n,
      requestedAmount: 30n
    });
  });

  it('is absent for an order that is not open', () => {
    expect(recoveredSwapOrderRef(recoveredSwap({}, { settledAt: 200 }))).toBeUndefined();
  });
});
