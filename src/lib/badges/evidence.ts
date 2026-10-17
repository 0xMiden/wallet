import { compareAccountIds } from 'lib/miden/activity/utils';
import type { BalanceRequirement } from 'lib/miden/balance-snapshot';
import { ITransactionStatus, type ITransaction, type ITransactionType } from 'lib/miden/db/types';

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
      if (typeof noteId !== 'string' || !['epoch', 'agglayer', 'usdcx'].includes(String(provider))) continue;
      const claim = eligible.find(
        other =>
          other.type === 'consume' &&
          other.transactionId === transactionId &&
          positive(other.amount) &&
          other.amount >= deposited &&
          compareAccountIds(row.accountId, other.accountId) &&
          other.consumedNotes?.some(
            note => noteKey(note.id) === noteKey(noteId) && note.faucetId === row.faucetId && note.amount === row.amount
          )
      );
      const balance = claim && row.faucetId ? consumedBalance(claim, row.faucetId) : undefined;
      if (balance) result.push({ badge: 'first-deposit', transactionIds: [transactionId], balances: [balance] });
    }
    if (!badges.includes('first-swap') || row.type !== 'swap' || !positive(row.amount) || !row.faucetId) continue;
    const requested: unknown = row.extraInputs?.requestedAmount;
    const faucet: unknown = row.extraInputs?.requestedFaucetId;
    const order: unknown = row.extraInputs?.orderId;
    if (!positive(requested) || typeof faucet !== 'string' || (typeof order !== 'string' && typeof order !== 'bigint'))
      continue;
    if (row.extraInputs?.reclaimedAt != null) continue;
    const claims = eligible.filter(
      other =>
        other.type === 'consume' &&
        compareAccountIds(row.accountId, other.accountId) &&
        other.extraInputs?.swapOrderTxId === row.id
    );
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
