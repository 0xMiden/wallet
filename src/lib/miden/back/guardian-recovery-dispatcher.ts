import type { GuardianSyncStatus } from 'lib/shared/types';

/**
 * THE one trigger table for guardian recovery.
 *
 * Recovery used to be spread across five mechanisms — drift reconciliation,
 * the 401 cold re-register, the missing-registration push, the outage banner,
 * the needs-URL prompt — each with a private entry predicate. The #786 review
 * kept finding states every predicate declined at once (a stranded custom
 * guardian, an operator that released the account, a submitted-unconfirmed
 * rotation), and rounds 17–20 each moved that wedge instead of removing it,
 * because fixing one predicate cannot prove the UNION covers the space.
 *
 * `classifyGuardianRecovery` is that union as one total function. The
 * companion totality test enumerates the whole fact-tuple product and asserts
 * the invariant the class violated: a state that blocks sends or carries a
 * pending rotation is NEVER routed `none-healthy` without a visible prompt.
 * A future state no mechanism claims fails CI, not the user.
 *
 * SHADOW-FIRST: the classifier currently *observes*. The sync loop builds the
 * facts it can assemble each tick, asks for a route, and logs when that route
 * disagrees with what the legacy predicates actually did
 * (`noteRecoveryDivergence`) — one release of divergence data before any
 * trigger moves. The single exception is `recheck-pending-rotation`: that
 * state had NO legacy owner (it is the W1 wedge itself), so its arm is live
 * from the start.
 */

/** Everything the dispatcher may reason from. Facts, not conclusions. */
export type GuardianFacts = {
  syncStatus: GuardianSyncStatus | undefined;
  hasHotKey: boolean;
  /** The realm's outage flag (consecutive server-down sync failures). */
  outage: boolean;
  /** Operator answers, account still unusable, automatic repair exhausted. */
  unrepairable: boolean;
  /**
   * A completed switch-guardian row whose commit was never confirmed
   * (`rotationVerdict` = 'submitted-unconfirmed'). The Dexie row IS the
   * durable intent: it survives realm churn and vault locks and already
   * carries the transaction id and target endpoint.
   */
  pendingRotation?: { txId: string };
  /** Seam-C budgets, so a spent budget routes to a prompt instead of a dead end. */
  budgets: {
    selfHeal: 'available' | 'spent';
    missingRegistration: 'available' | 'spent';
    recheck: 'available' | 'spent';
  };
};

/** Why the user is being asked — typed, so every prompt names its state. */
export type GuardianUserPromptReason =
  | 'needs-user-input'
  | 'outage'
  | 'unrepairable-manual'
  | 'rotation-unconfirmed-exhausted';

export type RecoveryRoute =
  | { route: 'none-healthy' }
  /** Verify a submitted-unconfirmed rotation against the node (the W1 exit). */
  | { route: 'recheck-pending-rotation'; txId: string }
  | { route: 'legacy-mechanisms' }
  | { route: 'prompt'; reason: GuardianUserPromptReason };

export function classifyGuardianRecovery(facts: GuardianFacts): RecoveryRoute {
  // A pending rotation outranks everything: until the chain answers, every
  // other verdict is about an operator binding that may not exist.
  if (facts.pendingRotation) {
    if (facts.budgets.recheck === 'spent') {
      return { route: 'prompt', reason: 'rotation-unconfirmed-exhausted' };
    }
    return { route: 'recheck-pending-rotation', txId: facts.pendingRotation.txId };
  }

  if (!facts.hasHotKey) return { route: 'none-healthy' };

  if (facts.syncStatus === 'needs-user-input') return { route: 'prompt', reason: 'needs-user-input' };
  if (facts.outage) return { route: 'prompt', reason: 'outage' };
  if (facts.unrepairable) return { route: 'prompt', reason: 'unrepairable-manual' };

  // A blocking status or a spent budget with none of the prompts above would
  // be a dead end; everything else is the legacy mechanisms' territory while
  // the dispatcher shadows them.
  if (facts.syncStatus === 'resolving') return { route: 'legacy-mechanisms' };
  if (facts.budgets.selfHeal === 'spent' || facts.budgets.missingRegistration === 'spent') {
    // A spent repair budget without the unrepairable flag means the flag write
    // was missed — surface it rather than sit silent.
    return { route: 'prompt', reason: 'unrepairable-manual' };
  }
  return { route: 'none-healthy' };
}

/** Does this route leave the user an exit? The totality test's core predicate. */
export function routeHasExit(route: RecoveryRoute): boolean {
  return route.route !== 'none-healthy';
}

// --- Shadow-mode divergence accounting --------------------------------------

const divergenceCounts = new Map<string, number>();

/**
 * Record that the classifier's route disagreed with what the legacy
 * predicates actually did this tick. Logged on the first occurrence per kind
 * and counted after, so a systematic divergence is loud without being a
 * per-tick firehose. `__getRecoveryDivergencesForTest` exposes the tally; the
 * flip to dispatcher-owned triggers happens only after a release of this
 * reading ~zero.
 */
export function noteRecoveryDivergence(kind: string): void {
  const count = (divergenceCounts.get(kind) ?? 0) + 1;
  divergenceCounts.set(kind, count);
  if (count === 1) {
    console.warn(`[GuardianRecovery] shadow divergence: ${kind} (further occurrences counted silently)`);
  }
}

export function __getRecoveryDivergencesForTest(): ReadonlyMap<string, number> {
  return divergenceCounts;
}

export function __resetRecoveryDivergencesForTest(): void {
  divergenceCounts.clear();
}
