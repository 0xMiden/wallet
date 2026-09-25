import { isGuardianDrifted, isGuardianSyncBlocked } from 'lib/miden/guardian/sync-guard';
import type { GuardianSyncStatus } from 'lib/shared/types';

/**
 * THE single derivation of every user-facing claim about a guardian's status.
 *
 * Rounds 21-25 of the #786 review each found another surface deriving "the
 * guardian is fine / the rotation happened" from its own subset of the raw
 * inputs - the settings pill certifying a guardian `assertGuardianInSync`
 * refuses to use, "Last sync" reading a wallet-wide stamp beside an Offline
 * pill, an Online verdict outliving the operator it was earned against. The
 * class recurs because nothing stopped surface N+1 from reading the raw fields
 * and inventing derivation N+1. This module is that stop: surfaces render what
 * `deriveGuardianPresentation` returns and nothing else, and a source-scan
 * fence (`guardian/guardian-claim-fence.test.ts`) keeps raw reads from compiling
 * back in elsewhere.
 *
 * Pure by design - the realm-local inputs (outage flag, unrepairable flag,
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

export type GuardianPresentation = {
  pill: GuardianPill;
  lastSync: GuardianLastSync;
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
  const drifted = isGuardianDrifted(account);
  // The guard's own predicate: no status it blocks may read 'online' (F-207), whether or
  // not this module names it.
  const blocked = isGuardianSyncBlocked(account);
  // Freshness without a stamp is a contradiction - a stamp is what freshness
  // is ABOUT - so it is defined away here rather than trusted from the caller.
  const lastSyncFresh = lastSyncAt !== undefined && input.lastSyncFresh;

  // Precedence is load-bearing. A blocked account is being reconciled or points at
  // the wrong operator (the reconciler writes 'resolving' only after the stored
  // endpoint denied the on-chain key), so it outranks the liveness flags, which
  // describe that endpoint, and reads Checking: it declines to certify, not accuses.
  const pill: GuardianPill = !account.hotPublicKey
    ? 'not-connected'
    : drifted
      ? 'drifted'
      : blocked
        ? 'checking'
        : outage
          ? 'offline'
          : unrepairable
            ? 'unrepairable'
            : lastSyncFresh
              ? 'online'
              : 'checking';

  // While the guard blocks, the stamp describes an endpoint the account no longer
  // points at or is leaving (F-143), so it is withheld rather than rendered
  // against the wrong subject.
  const lastSync: GuardianLastSync =
    lastSyncAt !== undefined && !blocked
      ? { kind: 'timestamp', at: lastSyncAt }
      : pill === 'checking'
        ? { kind: 'checking' }
        : pill === 'not-connected'
          ? { kind: 'never' }
          : { kind: 'unknown' };

  return { pill, lastSync };
}
