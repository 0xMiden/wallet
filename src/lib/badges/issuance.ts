import type { BalanceRequirement } from 'lib/miden/balance-snapshot';
import type { ITransaction } from 'lib/miden/db/types';

import { badgeCandidates, ISSUABLE_BADGES, type BadgeCandidate } from './evidence';
import { readEarnedBadges, type BadgeId } from './types';

export interface BadgeIssuanceSource {
  /** All local wallet accounts, not just the selected account. */
  accounts(): readonly string[];
  isMainnet(): boolean;
  /** False while the realm's client is fused: the pass takes no hold and leaves every candidate pending. */
  canVerify(): boolean;
  /** The Mainnet-stamped Completed rows these badges' evidence is built from. */
  readTransactions(badges: readonly BadgeId[]): Promise<ITransaction[]>;
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

// The first retry stays under the manager's 15 s cadence, so a commit that lands soon is seen on the next tick.
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;

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
  let awaitingBalance = false;
  // A commit is final, so a committed transaction is never asked about again.
  const committed = new Set<string>();
  const backoff = new Map<string, { failures: number; until: number }>();
  const isCurrent = (fingerprint: string) =>
    !stopped && source.isMainnet() && JSON.stringify([...source.accounts()].sort()) === fingerprint;
  const backOff = (key: string) => {
    const failures = (backoff.get(key)?.failures ?? 0) + 1;
    backoff.set(key, { failures, until: Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS) });
  };

  async function refresh(): Promise<void> {
    if (stopped) return;
    dirty = true;
    if (running) return;
    running = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        const accounts = [...source.accounts()];
        const fingerprint = JSON.stringify([...accounts].sort());
        const current = () => isCurrent(fingerprint);
        if (!current() || !source.canVerify()) continue;
        const earned = readEarnedBadges(await source.readAwards());
        const wanted = ISSUABLE_BADGES.filter(badge => !earned.includes(badge));
        if (!wanted.length) {
          awaitingBalance = false;
          continue;
        }
        const candidates = badgeCandidates(await source.readTransactions(wanted), accounts, wanted);
        const keys = new Set(candidates.map(candidateKey));
        for (const key of backoff.keys()) {
          if (!keys.has(key)) backoff.delete(key);
        }
        const uncommitted = new Set<string>();
        const additions: BadgeId[] = [];
        const verifiedCandidates = new Set<string>();
        let holds = 0;
        const reflected = (candidate: BadgeCandidate) =>
          candidate.balances?.every(requirement => source.isBalanceReflected(requirement)) ?? true;
        // Asked before every hold, not only at the start: a fuse lit mid-pass stops the next one too.
        const checkable = () => current() && source.canVerify();
        const verify = async (candidate: BadgeCandidate): Promise<Verdict> => {
          for (const id of candidate.transactionIds) {
            if (committed.has(id)) continue;
            if (uncommitted.has(id)) return 'not-committed';
            if (!checkable()) return 'not-checked';
            const verdict = await source.isCommitted(id);
            holds += 1;
            if (!current()) return 'not-checked';
            if (!verdict) {
              uncommitted.add(id);
              return 'not-committed';
            }
            committed.add(id);
          }
          if (!candidate.swap) return 'committed';
          if (!checkable()) return 'not-checked';
          const filled = await source.isFilledApprovedSwap(candidate.swap);
          holds += 1;
          if (!current()) return 'not-checked';
          return filled ? 'committed' : 'not-committed';
        };
        awaitingBalance = false;
        for (const candidate of candidates) {
          if (!current()) break;
          const key = candidateKey(candidate);
          if (additions.includes(candidate.badge) || (backoff.get(key)?.until ?? 0) > Date.now()) continue;
          if (!reflected(candidate)) {
            awaitingBalance = true;
            continue;
          }
          const verdict = await verify(candidate);
          // Only an answer backs a candidate off; one the pass never checked keeps its place.
          if (verdict === 'not-committed') backOff(key);
          if (verdict !== 'committed' || !current()) continue;
          backoff.delete(key);
          if (reflected(candidate)) {
            additions.push(candidate.badge);
            verifiedCandidates.add(key);
          } else {
            awaitingBalance = true;
          }
        }
        // A failed hold rejects out of the pass, so reaching here means every hold answered.
        if (holds > 0) source.reportVerified();
        if (current() && additions.length) {
          // A cancellation or a failed settlement may have changed while the SDK answered.
          const fresh = badgeCandidates(await source.readTransactions(additions), accounts, additions);
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
    /** A candidate waits only on its balance snapshot, so a balance landing can complete it. */
    awaitsBalance: () => awaitingBalance,
    stop() {
      stopped = true;
    }
  };
}
