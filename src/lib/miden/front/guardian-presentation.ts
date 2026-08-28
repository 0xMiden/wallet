import { isGuardianSyncBlocked } from 'lib/miden/guardian/sync-guard';
import type { GuardianSyncStatus } from 'lib/shared/types';

/**
 * THE single derivation of every user-facing claim about a guardian's status.
 *
 * Rounds 21–25 of the #786 review each found another surface deriving "the
 * guardian is fine / the rotation happened" from its own subset of the raw
 * inputs — the settings pill certifying a guardian `assertGuardianInSync`
 * refuses to use, "Last sync" reading a wallet-wide stamp beside an Offline
 * pill, an Online verdict outliving the operator it was earned against. The
 * class recurs because nothing stopped surface N+1 from reading the raw fields
 * and inventing derivation N+1. This module is that stop: surfaces render what
 * `deriveGuardianPresentation` returns and nothing else, and a source-scan
 * fence (guardian-presentation-fence.test.ts) keeps raw reads from compiling
 * back in elsewhere.
 *
 * Pure by design — the realm-local inputs (outage flag, unrepairable flag,
 * sync stamp) are passed in rather than read here, so every (input → claim)
 * pair is table-testable. `useGuardianPresentation` owns the wiring.
 */

export type GuardianPill = 'not-connected' | 'online' | 'checking' | 'offline' | 'drifted' | 'unrepairable';

/** How the "Last sync" row should read. The surface only formats; it never decides. */
export type GuardianLastSync =
  | { kind: 'timestamp'; at: number }
  | { kind: 'checking' }
  | { kind: 'never' }
  | { kind: 'unknown' };

export type GuardianPrompt = 'needs-user-input' | 'outage' | 'unrepairable-manual';

export type GuardianPresentation = {
  pill: GuardianPill;
  /** Red-family styling; true exactly for offline | unrepairable | drifted. */
  fault: boolean;
  lastSync: GuardianLastSync;
  /**
   * MUST equal what `assertGuardianInSync` decides for this account — the
   * F-207 invariant. A surface may say "Online" only while sends actually go.
   */
  sendsBlocked: boolean;
  /** Which recovery surface (if any) should be offered. */
  prompt?: GuardianPrompt;
};

export type GuardianPresentationInput = {
  account: { hotPublicKey?: string; guardianSyncStatus?: GuardianSyncStatus };
  /** Realm-local reads (front/guardian-sync.ts), passed in so this stays pure. */
  outage: boolean;
  unrepairable: boolean;
  lastSyncAt: number | undefined;
  lastSyncFresh: boolean;
};

export function deriveGuardianPresentation(input: GuardianPresentationInput): GuardianPresentation {
  const { account, outage, unrepairable, lastSyncAt } = input;
  const drifted = account.guardianSyncStatus === 'needs-user-input';
  const resolving = account.guardianSyncStatus === 'resolving';
  // Freshness without a stamp is a contradiction — a stamp is what freshness
  // is ABOUT — so it is defined away here rather than trusted from the caller.
  const lastSyncFresh = lastSyncAt !== undefined && input.lastSyncFresh;

  // Precedence is load-bearing and mirrors the guard: a drifted or resolving
  // account never reads 'online', because `assertGuardianInSync` refuses it.
  const pill: GuardianPill = !account.hotPublicKey
    ? 'not-connected'
    : drifted
      ? 'drifted'
      : outage
        ? 'offline'
        : unrepairable
          ? 'unrepairable'
          : resolving || !lastSyncFresh
            ? 'checking'
            : 'online';

  const fault = pill === 'offline' || pill === 'unrepairable' || pill === 'drifted';

  // A drifted account's stamp describes the PREVIOUS operator — every fact on
  // the page is about an endpoint the account no longer points at (F-143), so
  // the timestamp is withheld rather than rendered against the wrong subject.
  const lastSync: GuardianLastSync =
    lastSyncAt !== undefined && !drifted
      ? { kind: 'timestamp', at: lastSyncAt }
      : pill === 'checking'
        ? { kind: 'checking' }
        : pill === 'not-connected'
          ? { kind: 'never' }
          : { kind: 'unknown' };

  // THE `assertGuardianInSync` predicate — imported, not restated, so the pill
  // and the guard cannot drift apart again (F-207).
  const sendsBlocked = isGuardianSyncBlocked(account);

  const prompt: GuardianPrompt | undefined = drifted
    ? 'needs-user-input'
    : pill === 'offline'
      ? 'outage'
      : pill === 'unrepairable'
        ? 'unrepairable-manual'
        : undefined;

  return { pill, fault, lastSync, sendsBlocked, prompt };
}
