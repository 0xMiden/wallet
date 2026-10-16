import type { ITransaction } from 'lib/miden/db/types';

import { badgeCandidates, type BadgeCandidate } from './evidence';
import { readEarnedBadges, type BadgeId } from './types';

export interface BadgeIssuanceSource {
  /** All local wallet accounts, not just the selected account. */
  accounts(): readonly string[];
  isMainnet(): boolean;
  readTransactions(): Promise<ITransaction[]>;
  isCommitted(transactionId: string): Promise<boolean>;
  isFilledApprovedSwap(swap: NonNullable<BadgeCandidate['swap']>): Promise<boolean>;
  readAwards(): Promise<unknown>;
  /** Must merge under a cross-context storage lock, rechecking `isCurrent` before writing. */
  mergeAwards(awards: readonly BadgeId[], isCurrent: () => boolean): Promise<void>;
  reportError(error: unknown): void;
}

const candidateKey = (candidate: BadgeCandidate) =>
  JSON.stringify([candidate.badge, [...candidate.transactionIds].sort(), candidate.swap ?? null]);

/** One flight per controller. DB commits wake it immediately; retries also cover later chain confirmation. */
export function createBadgeIssuer(source: BadgeIssuanceSource) {
  let stopped = false;
  let running = false;
  let dirty = false;
  let generation = 0;
  const isCurrent = (epoch: number, fingerprint: string) =>
    !stopped &&
    epoch === generation &&
    source.isMainnet() &&
    JSON.stringify([...source.accounts()].sort()) === fingerprint;

  async function refresh(): Promise<void> {
    if (stopped) return;
    dirty = true;
    if (running) return;
    running = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        const epoch = generation;
        const accounts = [...source.accounts()];
        const fingerprint = JSON.stringify([...accounts].sort());
        const current = () => isCurrent(epoch, fingerprint);
        if (!current()) continue;
        const earned = readEarnedBadges(await source.readAwards());
        if (['first-send', 'first-deposit', 'first-swap'].every(id => earned.some(badge => badge === id))) continue;
        const candidates = badgeCandidates(await source.readTransactions(), accounts);
        const verified = new Map<string, boolean>();
        const additions: BadgeId[] = [];
        const verifiedCandidates = new Set<string>();
        for (const candidate of candidates) {
          if (!current()) break;
          if (earned.includes(candidate.badge) || additions.includes(candidate.badge)) continue;
          let committed = true;
          for (const id of candidate.transactionIds) {
            if (!current()) {
              committed = false;
              break;
            }
            const verdict = verified.get(id) ?? (await source.isCommitted(id));
            verified.set(id, verdict);
            if (!verdict) {
              committed = false;
              break;
            }
          }
          if (!committed || !current()) continue;
          if (candidate.swap && !(await source.isFilledApprovedSwap(candidate.swap))) continue;
          if (current()) {
            additions.push(candidate.badge);
            verifiedCandidates.add(candidateKey(candidate));
          }
        }
        if (current() && additions.length) {
          // A cancellation or a failed settlement may have changed while the SDK answered.
          const fresh = badgeCandidates(await source.readTransactions(), accounts);
          const stillEligible = additions.filter(badge =>
            fresh.some(candidate => candidate.badge === badge && verifiedCandidates.has(candidateKey(candidate)))
          );
          if (current() && stillEligible.length) await source.mergeAwards(stillEligible, current);
        }
      }
    } catch (error) {
      source.reportError(error);
    } finally {
      running = false;
    }
  }

  return {
    refresh,
    invalidate() {
      generation += 1;
    },
    stop() {
      stopped = true;
      generation += 1;
    }
  };
}
