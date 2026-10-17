import { compareAccountIds } from 'lib/miden/activity/utils';
import type { BalanceRequirement } from 'lib/miden/balance-snapshot';
import { ITransactionStatus, type IConsumedNote, type ITransaction, type ITransactionType } from 'lib/miden/db/types';

import { BADGE_IDS, type BadgeId } from './types';

export interface BadgeCandidate {
  badge: BadgeId;
  transactionIds: string[];
  balances?: BalanceRequirement[];
  swap?: { orderId: string; offeredFaucetId: string; requestedFaucetId: string };
}

/** The row types each badge's evidence is built from; a badge with none has no reliable signal yet and never issues. */
export const BADGE_EVIDENCE_TYPES: Readonly<Record<BadgeId, readonly ITransactionType[]>> = {
  'first-deposit': ['bridged-receive', 'consume'],
  'first-receive': [],
  'first-send': ['send'],
  'first-swap': ['swap', 'consume'],
  'recovery-checked': [],
  'miniapp-explorer': []
};
export const ISSUABLE_BADGES: readonly BadgeId[] = BADGE_IDS.filter(badge => BADGE_EVIDENCE_TYPES[badge].length > 0);
export const evidenceTypes = (badges: readonly BadgeId[]): ITransactionType[] => [
  ...new Set(badges.flatMap(badge => BADGE_EVIDENCE_TYPES[badge]))
];

const positive = (value: unknown): value is bigint => typeof value === 'bigint' && value > 0n;
const chainId = (value: unknown): value is string => typeof value === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(value);
const noteKey = (id: string) => id.toLowerCase().replace(/^0x/, '');

const addTo = <K, V>(index: Map<K, V[]>, key: K, value: V) => {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
};

// A batch claim's scalar amount totals only its first note's faucet, so read each faucet's own total.
function consumedTotals(claim: ITransaction): (faucetId: string) => bigint | undefined {
  if (claim.assetTotals) {
    const totals = new Map<string, bigint>();
    for (const { faucetId, amount } of claim.assetTotals) if (!totals.has(faucetId)) totals.set(faucetId, amount);
    return faucetId => totals.get(faucetId);
  }
  const faucets = new Set(claim.consumedNotes?.map(note => note.faucetId));
  return faucetId => (faucets.size === 1 && faucets.has(faucetId) ? claim.amount : undefined);
}

function claimedNotes(claim: ITransaction): Map<string, IConsumedNote[]> {
  const notes = new Map<string, IConsumedNote[]>();
  for (const note of claim.consumedNotes ?? []) addTo(notes, noteKey(note.id), note);
  return notes;
}

// A consume is read once per call, however many deposits it claims.
function readOnce<T>(read: (claim: ITransaction) => T): (claim: ITransaction) => T {
  const cache = new Map<ITransaction, T>();
  return claim => {
    const cached = cache.get(claim);
    if (cached !== undefined) return cached;
    const value = read(claim);
    cache.set(claim, value);
    return value;
  };
}

function consumedBalance(row: ITransaction, faucetId: string): BalanceRequirement | undefined {
  const attempts = row.submitEvidence?.filter(
    attempt =>
      chainId(attempt.transactionId) &&
      chainId(row.transactionId) &&
      noteKey(attempt.transactionId) === noteKey(row.transactionId)
  );
  if (!attempts?.length) return undefined;
  const nonces = attempts.map(attempt => attempt.initialNonce);
  const nonce = nonces[0];
  if (nonce === undefined || !/^\d+$/.test(nonce) || nonces.some(value => value !== nonce)) return undefined;
  return { accountId: row.accountId, faucetId, minimumNonce: String(BigInt(nonce) + 1n) };
}

/**
 * Candidate selection is deliberately weaker than issuance: every named chain transaction must
 * still be confirmed by the synced SDK record. Missing provenance never means Mainnet.
 */
export function badgeCandidates(
  rows: readonly ITransaction[],
  accounts: readonly string[],
  badges: readonly BadgeId[] = ISSUABLE_BADGES
): BadgeCandidate[] {
  const eligible = rows.filter(
    row =>
      row.badgeNetwork === 'mainnet' &&
      row.status === ITransactionStatus.Completed &&
      !row.restoredFromBackup &&
      !row.recovered &&
      chainId(row.transactionId) &&
      accounts.some(account => compareAccountIds(account, row.accountId))
  );
  // Each row reads only its own claims; buckets keep history order, so the first qualifying claim still wins.
  const claimsByTransaction = new Map<string, ITransaction[]>();
  const claimsByOrder = new Map<string, ITransaction[]>();
  for (const other of eligible) {
    if (other.type !== 'consume' || !chainId(other.transactionId)) continue;
    addTo(claimsByTransaction, other.transactionId, other);
    const order: unknown = other.extraInputs?.swapOrderTxId;
    if (typeof order === 'string') addTo(claimsByOrder, order, other);
  }
  const totalsOf = readOnce(consumedTotals);
  const notesOf = readOnce(claimedNotes);
  const result: BadgeCandidate[] = [];
  for (const row of eligible) {
    const transactionId = row.transactionId;
    if (!chainId(transactionId)) continue;
    if (
      badges.includes('first-send') &&
      row.type === 'send' &&
      positive(row.amount) &&
      row.faucetId &&
      row.secondaryAccountId &&
      !row.dappOrigins?.length &&
      !accounts.some(account => compareAccountIds(account, row.secondaryAccountId ?? ''))
    ) {
      result.push({ badge: 'first-send', transactionIds: [transactionId] });
    }
    if (
      badges.includes('first-deposit') &&
      row.type === 'bridged-receive' &&
      row.extraInputs?.phase === 'received' &&
      positive(row.amount)
    ) {
      const deposited = row.amount;
      const noteId: unknown = row.extraInputs.midenNoteId;
      const provider: unknown = row.extraInputs.provider;
      const faucetId = row.faucetId;
      if (typeof noteId !== 'string' || !faucetId || !['epoch', 'agglayer', 'usdcx'].includes(String(provider)))
        continue;
      const depositNote = noteKey(noteId);
      const claim = claimsByTransaction.get(transactionId)?.find(
        other =>
          (totalsOf(other)(faucetId) ?? 0n) >= deposited &&
          compareAccountIds(row.accountId, other.accountId) &&
          notesOf(other)
            .get(depositNote)
            ?.some(note => note.faucetId === faucetId && note.amount === row.amount)
      );
      const balance = claim ? consumedBalance(claim, faucetId) : undefined;
      if (balance) result.push({ badge: 'first-deposit', transactionIds: [transactionId], balances: [balance] });
    }
    if (!badges.includes('first-swap') || row.type !== 'swap' || !positive(row.amount) || !row.faucetId) continue;
    const requested: unknown = row.extraInputs?.requestedAmount;
    const faucet: unknown = row.extraInputs?.requestedFaucetId;
    const order: unknown = row.extraInputs?.orderId;
    if (!positive(requested) || typeof faucet !== 'string' || (typeof order !== 'string' && typeof order !== 'bigint'))
      continue;
    if (row.extraInputs?.reclaimedAt != null) continue;
    const claims = (claimsByOrder.get(row.id) ?? []).filter(other => compareAccountIds(row.accountId, other.accountId));
    if (claims.some(claim => claim.extraInputs?.swapSettleKind === 'reclaim')) continue;
    const seenNotes = new Set<string>();
    const seenTransactions = new Set<string>();
    const transactions = [transactionId];
    const balances: BalanceRequirement[] = [];
    let received = 0n;
    for (const claim of claims) {
      if (claim.extraInputs?.swapSettleKind !== 'settle' || claim.faucetId !== faucet || !positive(claim.amount))
        continue;
      const ids = claim.noteIds ?? (claim.noteId ? [claim.noteId] : []);
      const keys = ids.map(noteKey);
      if (!keys.length || new Set(keys).size !== keys.length || keys.some(id => seenNotes.has(id))) continue;
      if (!chainId(claim.transactionId) || seenTransactions.has(claim.transactionId)) continue;
      const balance = consumedBalance(claim, faucet);
      if (!balance) continue;
      keys.forEach(id => seenNotes.add(id));
      seenTransactions.add(claim.transactionId);
      received += claim.amount;
      transactions.push(claim.transactionId);
      balances.push(balance);
    }
    if (received >= requested)
      result.push({
        badge: 'first-swap',
        transactionIds: transactions,
        balances,
        swap: { orderId: String(order), offeredFaucetId: row.faucetId, requestedFaucetId: faucet }
      });
  }
  // First Receive needs reliable native-payment provenance (a late bridge tag is not its absence).
  // Recovery and miniapps need reviewed account-recovery / app-completion signals. Fail closed.
  return result;
}
