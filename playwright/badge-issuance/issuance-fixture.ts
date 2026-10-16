// Browser-only test harness. Never imported by the production application.
// Separate database + mocked chain verdicts: no wallet, authentication, SDK signer or RPC.
import Dexie, { liveQuery } from 'dexie';
import type { ITransaction } from '../../src/lib/miden/db/types';
import { createBadgeIssuer } from '../../src/lib/badges/issuance';
import { BADGE_STORAGE_KEY, readEarnedBadges } from '../../src/lib/badges/types';
import { fetchFromStorage, putToStorage } from './storage';

const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const row = (patch: Partial<ITransaction> = {}): ITransaction => ({
  id: 'send',
  type: 'send',
  accountId: 'fixture-account-b',
  secondaryAccountId: 'recipient',
  amount: 10n,
  faucetId: 'coin-a',
  badgeNetwork: 'mainnet',
  status: 0,
  initiatedAt: 1,
  transactionId: hash(1),
  displayIcon: 'SEND',
  ...patch
});
export async function initializeBadgeFixture() {
  const db = new Dexie('BreadBadgeIssuanceTest');
  db.version(1).stores({ events: 'id' });
  const events = db.table<ITransaction, string>('events');
  const committed = new Set<string>();
  let fullLineage = false;
  const issuer = createBadgeIssuer({
    accounts: () => ['fixture-account-a', 'fixture-account-b'],
    isMainnet: () => new URLSearchParams(location.search).get('network') === 'mainnet',
    readTransactions: () => events.toArray(),
    isCommitted: async id => committed.has(id),
    isFilledApprovedSwap: async () => fullLineage,
    readAwards: fetchFromStorage,
    mergeAwards: async (ids, current) => {
      const previous = readEarnedBadges(await fetchFromStorage());
      if (current()) await putToStorage(BADGE_STORAGE_KEY, readEarnedBadges([...previous, ...ids]));
    },
    reportError: error => {
      throw error;
    }
  });
  liveQuery(() => events.toArray()).subscribe(() => void issuer.refresh());
  const api = {
    async send(status = 0, network = 'mainnet', confirmed = false) {
      if (confirmed) committed.add(hash(1));
      await events.put(row({ status, badgeNetwork: network }));
      await issuer.refresh();
    },
    async deposit(phase: string, claim = false) {
      committed.add(hash(2));
      await events.put(
        row({
          id: 'deposit',
          type: 'bridged-receive',
          status: 2,
          transactionId: hash(2),
          extraInputs: { phase, provider: 'epoch', midenNoteId: 'deposit-note' }
        })
      );
      if (claim)
        await events.put(
          row({
            id: 'deposit-claim',
            type: 'consume',
            status: 2,
            transactionId: hash(2),
            consumedNotes: [{ id: 'deposit-note', senderAddress: 'bridge', faucetId: 'coin-a', amount: 10n }]
          })
        );
      await issuer.refresh();
    },
    async swap(amount: number, filled: boolean, reclaim = false) {
      fullLineage = filled;
      committed.add(hash(3));
      committed.add(hash(4));
      await events.put(
        row({
          id: 'swap',
          type: 'swap',
          status: 2,
          transactionId: hash(3),
          extraInputs: { requestedAmount: 100n, requestedFaucetId: 'coin-b', orderId: '7' }
        })
      );
      if (amount > 0)
        await events.put(
          row({
            id: 'swap-claim',
            type: 'consume',
            status: 2,
            transactionId: hash(4),
            faucetId: 'coin-b',
            amount: BigInt(amount),
            noteIds: ['swap-output'],
            extraInputs: { swapOrderTxId: 'swap', swapSettleKind: reclaim ? 'reclaim' : 'settle' }
          })
        );
      await issuer.refresh();
    },
    async reset() {
      issuer.invalidate();
      await events.clear();
      committed.clear();
      fullLineage = false;
      await putToStorage(BADGE_STORAGE_KEY, []);
    }
  };
  Object.assign(window, { __badgeTest: api });
  await issuer.refresh();
}
