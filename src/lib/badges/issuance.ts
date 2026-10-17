import type { BalanceRequirement } from 'lib/miden/balance-snapshot';
import type { ITransaction } from 'lib/miden/db/types';

import { badgeCandidates, type BadgeCandidate } from './evidence';
import { readEarnedBadges, type BadgeId } from './types';

export interface BadgeIssuanceSource {
  /** All local wallet accounts, not just the selected account. */
  accounts(): readonly string[];
  isMainnet(): boolean;
  /** False while the realm's client is fused: the pass takes no hold and leaves every candidate pending. */
  canVerify(): boolean;
  readTransactions(): Promise<ITransaction[]>;
  /** A hold: books its own failure against the fuse before rejecting. */
  isCommitted(transactionId: string): Promise<boolean>;
  isBalanceReflected(requirement: BalanceRequirement): boolean;
  /** A hold, like `isCommitted`. */
  isFilledApprovedSwap(swap: NonNullable<BadgeCandidate['swap']>): Promise<boolean>;
  /** Every hold the pass took answered. */
  reportVerified(): void;
  readAwards(): Promise<unknown>;
  /** Must merge under a cross-context storage lock, rechecking `isCurrent` before writing. */
  mergeAwards(awards: readonly BadgeId[], isCurrent: () => boolean): Promise<void>;
  reportError(error: unknown): void;
}

/** Not checked: a fuse lit or the pass went stale first, so the candidate stays pending as it was. */
type Verdict = 'committed' | 'not-committed' | 'not-checked';

const candidateKey = (candidate: BadgeCandidate) =>
  JSON.stringify([
    candidate.badge,
    [...candidate.transactionIds].sort(),
    candidate.swap ?? null,
    candidate.balances ?? []
  ]);

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
        if (!current() || !source.canVerify()) continue;
        const earned = readEarnedBadges(await source.readAwards());
        if (['first-send', 'first-deposit', 'first-swap'].every(id => earned.some(badge => badge === id))) continue;
        const candidates = badgeCandidates(await source.readTransactions(), accounts);
        const verified = new Map<string, boolean>();
        const additions: BadgeId[] = [];
        const verifiedCandidates = new Set<string>();
        let holds = 0;
        const reflected = (candidate: BadgeCandidate) =>
          candidate.balances?.every(requirement => source.isBalanceReflected(requirement)) ?? true;
        // Asked before every hold, not only at the start: a fuse lit mid-pass stops the next one too.
        const checkable = () => current() && source.canVerify();
        const verify = async (candidate: BadgeCandidate): Promise<Verdict> => {
          for (const id of candidate.transactionIds) {
            let verdict = verified.get(id);
            if (verdict === undefined) {
              if (!checkable()) return 'not-checked';
              verdict = await source.isCommitted(id);
              holds += 1;
              verified.set(id, verdict);
            }
            if (!current()) return 'not-checked';
            if (!verdict) return 'not-committed';
          }
          if (!candidate.swap) return 'committed';
          if (!checkable()) return 'not-checked';
          const filled = await source.isFilledApprovedSwap(candidate.swap);
          holds += 1;
          if (!current()) return 'not-checked';
          return filled ? 'committed' : 'not-committed';
        };
        for (const candidate of candidates) {
          if (!current()) break;
          if (earned.includes(candidate.badge) || additions.includes(candidate.badge) || !reflected(candidate))
            continue;
          if ((await verify(candidate)) !== 'committed' || !current()) continue;
          if (reflected(candidate)) {
            additions.push(candidate.badge);
            verifiedCandidates.add(candidateKey(candidate));
          }
        }
        // A failed hold rejects out of the pass, so reaching here means every hold answered.
        if (holds > 0) source.reportVerified();
        if (current() && additions.length) {
          // A cancellation or a failed settlement may have changed while the SDK answered.
          const fresh = badgeCandidates(await source.readTransactions(), accounts);
          const stillEligible = fresh.filter(
            candidate =>
              additions.includes(candidate.badge) &&
              verifiedCandidates.has(candidateKey(candidate)) &&
              reflected(candidate)
          );
          // Storage locking can await another context: recheck the *displayed* snapshots there too.
          const ready = () => current() && stillEligible.every(reflected);
          if (ready() && stillEligible.length)
            await source.mergeAwards(
              stillEligible.map(candidate => candidate.badge),
              ready
            );
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
