import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import {
  isHeldBackPeerSwapPayback,
  isPeerSwapPayback,
  localSwapOrders,
  PEER_SWAP_PAYBACK_HOLD_SECONDS
} from './classification';

// `settlement.test.ts` mocks `Repo.transactions.filter` to return a fixed array,
// so the predicate inside `localSwapOrders` never actually runs there. These
// apply it, which is the only way its clauses can be pinned.
jest.mock('lib/miden/repo', () => ({
  transactions: { filter: jest.fn(), where: jest.fn() }
}));

const ACCOUNT = 'account-1';

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'swap-1',
  type: 'swap',
  status: ITransactionStatus.Completed,
  accountId: ACCOUNT,
  initiatedAt: 10,
  completedAt: 100,
  extraInputs: { requestedFaucetId: 'requested', requestedAmount: 50n, orderId: 77n },
  ...overrides
});

/** Run the real predicate over `rows`, the way Dexie would. */
const withRows = (rows: unknown[]) => {
  (Repo.transactions.filter as jest.Mock).mockImplementation((predicate: (row: unknown) => boolean) => ({
    toArray: async () => rows.filter(predicate)
  }));
};

describe('localSwapOrders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns this account’s completed swap orders', async () => {
    withRows([order()]);

    expect(await localSwapOrders(ACCOUNT)).toHaveLength(1);
  });

  // The list means "orders created by THIS wallet", and downstream it drives
  // reclaim — a real consume against the order's own `expiresAt` and asset data.
  // A restored row is not evidence the wallet ever placed that order.
  it('excludes an order restored from a backup', async () => {
    withRows([order({ id: 'restored', restoredFromBackup: true })]);

    expect(await localSwapOrders(ACCOUNT)).toEqual([]);
  });

  it('keeps a genuine order alongside a restored one', async () => {
    withRows([order({ id: 'restored', restoredFromBackup: true }), order({ id: 'mine' })]);

    expect((await localSwapOrders(ACCOUNT)).map(o => o.id)).toEqual(['mine']);
  });

  // A Guardian-recovered order joins only once this wallet's Cancel stamped it: its order note is then reclaimed from
  // the node (#1487). Without that stamp it is as inert as any restored row.
  const recovered = (extraInputs: Record<string, unknown> = {}, id = 'recovered') =>
    order({
      id,
      restoredFromBackup: true,
      recovered: true,
      amount: 50n,
      outputNoteIds: ['order-note'],
      recovery: {
        outputNotes: [
          { id: 'order-note', swap: { orderId: '77', requestedAsset: { faucetId: 'requested', amount: '50' } } }
        ]
      },
      extraInputs: {
        requestedFaucetId: 'requested',
        requestedAmount: 50n,
        orderId: '77',
        autoConsume: false,
        ...extraInputs
      }
    });

  it("admits a recovered order this wallet's Cancel stamped", async () => {
    withRows([recovered({ expiresAt: 150, expiryTriggeredAt: 150 }), recovered({}, 'recovered-unstamped')]);

    expect((await localSwapOrders(ACCOUNT)).map(o => o.id)).toEqual(['recovered']);
  });

  it.each([
    ['carries no Cancel', {}],
    ['its lineage has closed reclaimed since', { expiryTriggeredAt: 150, reclaimedAt: 160, lineageClosedAt: 160 }],
    ['the node showed spent', { expiryTriggeredAt: 150, orderNoteSpentAt: 160 }]
  ])('keeps out a recovered order that %s', async (_label, extraInputs) => {
    withRows([recovered(extraInputs)]);

    expect(await localSwapOrders(ACCOUNT)).toEqual([]);
  });

  it.each([
    ['another account', { accountId: 'someone-else' }],
    ['a row that is not complete', { status: ITransactionStatus.Failed }],
    ['a swap with no order id', { extraInputs: { requestedFaucetId: 'r', requestedAmount: 1n } }]
  ])('excludes %s', async (_label, overrides) => {
    withRows([order(overrides)]);

    expect(await localSwapOrders(ACCOUNT)).toEqual([]);
  });
});

describe('peer swap paybacks (multi-device)', () => {
  const OWN = new Set(['77']);

  it('flags a payback of an order this device did not place', () => {
    expect(isPeerSwapPayback({ swapAttachment: { orderId: '901', depth: 1 } }, OWN)).toBe(true);
    expect(isPeerSwapPayback({ swapAttachment: { orderId: '901', depth: 1 } }, new Set())).toBe(true);
  });

  it("does not flag a payback of this device's own order, nor a note with no attachment", () => {
    expect(isPeerSwapPayback({ swapAttachment: { orderId: '77', depth: 2 } }, OWN)).toBe(false);
    expect(isPeerSwapPayback({ swapAttachment: null }, OWN)).toBe(false);
  });

  it('holds a peer payback back only while it is younger than the hold', () => {
    const now = 1_000_000;
    const at = (age: number) => ({ peerSwapPayback: true, receivedAt: now - age });
    expect(isHeldBackPeerSwapPayback(at(0), now)).toBe(true);
    expect(isHeldBackPeerSwapPayback(at(PEER_SWAP_PAYBACK_HOLD_SECONDS - 1), now)).toBe(true);
    expect(isHeldBackPeerSwapPayback(at(PEER_SWAP_PAYBACK_HOLD_SECONDS), now)).toBe(false);
  });

  it('never holds back a note with no known receive time, nor a note that is not a peer payback', () => {
    expect(isHeldBackPeerSwapPayback({ peerSwapPayback: true }, 1_000_000)).toBe(false);
    expect(isHeldBackPeerSwapPayback({ receivedAt: 1_000_000 }, 1_000_000)).toBe(false);
    expect(isHeldBackPeerSwapPayback({ peerSwapPayback: false, receivedAt: 1_000_000 }, 1_000_000)).toBe(false);
  });
});
