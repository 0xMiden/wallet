import { compareAccountIds } from 'lib/miden/activity/utils';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';

import { BADGE_EVIDENCE_TYPES, ISSUABLE_BADGES } from './evidence';
import { readEarnedBadges, type BadgeId } from './types';

/** Read completed history without an SDK request or a current balance snapshot. */
export function badgesFromHistory(
  rows: readonly ITransaction[],
  accounts: readonly string[],
  wanted: readonly BadgeId[]
): BadgeId[] {
  const completed = rows.filter(
    row =>
      (row.badgeNetwork ?? row.recovery?.network) === 'mainnet' &&
      row.status === ITransactionStatus.Completed &&
      (!row.restoredFromBackup || row.recovered === true) &&
      accounts.some(account => compareAccountIds(account, row.accountId))
  );
  return wanted.filter(badge =>
    completed.some(row => {
      if (!BADGE_EVIDENCE_TYPES[badge].includes(row.type) || !row.amount || row.amount <= 0n) return false;
      switch (badge) {
        case 'first-send':
          return (
            row.type === 'send' &&
            !!row.secondaryAccountId &&
            !row.dappOrigins?.length &&
            !accounts.some(account => compareAccountIds(account, row.secondaryAccountId ?? ''))
          );
        case 'first-deposit':
          return row.type === 'bridged-receive' && row.extraInputs?.phase === 'received';
        case 'first-swap': {
          if (row.type !== 'swap' || row.extraInputs?.reclaimedAt != null) return false;
          const requested = row.extraInputs?.requestedAmount;
          const faucet = row.extraInputs?.requestedFaucetId;
          if (typeof requested !== 'bigint' || requested <= 0n || typeof faucet !== 'string') return false;
          const claims = completed.filter(
            claim =>
              claim.type === 'consume' &&
              claim.extraInputs?.swapOrderTxId === row.id &&
              compareAccountIds(claim.accountId, row.accountId)
          );
          if (claims.some(claim => claim.extraInputs?.swapSettleKind === 'reclaim')) return false;
          const notes = new Set<string>();
          const received = claims.reduce((total, claim) => {
            if (claim.extraInputs?.swapSettleKind !== 'settle' || claim.faucetId !== faucet || !claim.amount)
              return total;
            const ids = (claim.noteIds ?? (claim.noteId ? [claim.noteId] : [])).map(id =>
              id.toLowerCase().replace(/^0x/, '')
            );
            if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => notes.has(id))) return total;
            if (claim.amount <= 0n) return total;
            ids.forEach(id => notes.add(id));
            return total + claim.amount;
          }, 0n);
          return received >= requested;
        }
        default:
          return false;
      }
    })
  );
}

export interface BadgeBackfillSource {
  readAwards(): Promise<readonly BadgeId[]>;
  readTransactions(wanted: readonly BadgeId[]): Promise<ITransaction[]>;
  accounts: readonly string[];
  isCurrent(): boolean;
  mergeAwards(additions: readonly BadgeId[], current: () => boolean): Promise<void>;
}

/** Read the saved awards first. Read history only for badges that are still missing. */
export async function backfillWalletBadges(source: BadgeBackfillSource): Promise<void> {
  const earned = readEarnedBadges(await source.readAwards());
  const wanted = ISSUABLE_BADGES.filter(badge => !earned.includes(badge));
  if (!wanted.length || !source.isCurrent()) return;
  const rows = await source.readTransactions(wanted);
  if (!source.isCurrent()) return;
  const additions = badgesFromHistory(rows, source.accounts, wanted);
  if (additions.length) await source.mergeAwards(additions, source.isCurrent);
}
