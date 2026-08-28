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
 * SHADOW-ONLY: the classifier *observes*. The sync loop builds the facts each
 * tick, asks for a route, and counts when that route disagrees with what the
 * legacy predicates actually did (`noteRecoveryDivergence`) — one release of
 * divergence data before any trigger moves. NOTHING here drives behaviour yet,
 * including `recheck-pending-rotation`: that state had no legacy owner, so the
 * sync loop owns it directly (`runPendingRotationRecheck`) and the classifier
 * only agrees or disagrees with it. An earlier version of this comment claimed
 * that arm was "live from the start"; it was not, and the claim hid the fact
 * that two of the three budgets reaching the classifier were hardcoded
 * constants, which is what made the divergence tally read low by construction.
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
   * carries the on-chain hash and target endpoint.
   *
   * `rowId` is the LOCAL Dexie id, not the on-chain transaction hash — the two
   * are different identifiers and conflating them cost this seam its whole
   * exit path once already. The route carries the row id because settling the
   * row is what the consumer does with it; whoever asks the NODE must read
   * `transactionId` off the row itself.
   */
  pendingRotation?: { rowId: string };
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
  | { route: 'recheck-pending-rotation'; rowId: string }
  | { route: 'legacy-mechanisms' }
  | { route: 'prompt'; reason: GuardianUserPromptReason };

export function classifyGuardianRecovery(facts: GuardianFacts): RecoveryRoute {
  // A pending rotation outranks everything: until the chain answers, every
  // other verdict is about an operator binding that may not exist.
  if (facts.pendingRotation) {
    if (facts.budgets.recheck === 'spent') {
      return { route: 'prompt', reason: 'rotation-unconfirmed-exhausted' };
    }
    return { route: 'recheck-pending-rotation', rowId: facts.pendingRotation.rowId };
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
