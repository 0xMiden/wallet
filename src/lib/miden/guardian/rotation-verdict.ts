import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';

/**
 * THE single reader of a switch-guardian row's outcome flags.
 *
 * `commitUnconfirmed`, `registerFailed` and `endpointPersistFailed` are written
 * in exactly one place (`transaction/complete.ts`) but were read by every
 * surface independently, and rounds 21–25 of the #786 review each found
 * another surface certifying a rotation the wallet never confirmed — the
 * receipt, the reconcile path, the Activity title, the details chip. The class
 * recurs because a surface that reads the raw flags can (and did, F-222) treat
 * an absent flag as evidence. This module closes that: surfaces consume a
 * `RotationVerdict`, where "unconfirmed" is a variant rather than a default,
 * and a source-scan fence (guardian-claim-fence.test.ts) keeps raw flag reads
 * from returning elsewhere.
 */

export type RotationVerdict =
  /** Queued or generating — no outcome to claim yet. */
  | { kind: 'in-flight' }
  /** Committed on chain, every post-commit step landed. The only variant that may render full confidence. */
  | { kind: 'confirmed' }
  /**
   * SUBMITTED, and nothing established that it committed. Not a failure — the
   * pipeline completed the row deliberately (the alternative strands the
   * account on an operator already judged unreachable) — but "went ahead on no
   * evidence" must never render as "confirmed".
   */
  | { kind: 'submitted-unconfirmed'; endpointPersisted: boolean; registered: boolean }
  /** Committed on chain, but a post-commit step (endpoint persist / registration) did not land. */
  | { kind: 'completed-degraded'; endpointPersisted: boolean; registered: boolean }
  | { kind: 'failed' };

export type RotationVerdictKind = RotationVerdict['kind'];

/**
 * Derive the verdict for a transaction row. Returns null for anything that is
 * not a switch-guardian row, so list surfaces can call it unconditionally.
 */
export function rotationVerdict(
  tx: Pick<ITransaction, 'type' | 'status' | 'extraInputs'> | undefined
): RotationVerdict | null {
  if (tx?.type !== 'switch-guardian') return null;

  if (tx.status === ITransactionStatus.Failed) return { kind: 'failed' };
  if (tx.status !== ITransactionStatus.Completed) return { kind: 'in-flight' };

  // Strict === true on every flag: these are the only reads of the raw fields,
  // and an absent flag on a legacy row means "predates the audit trail", which
  // must present exactly like a clean switch — not like new evidence.
  const endpointPersisted = tx.extraInputs?.endpointPersistFailed !== true;
  const registered = tx.extraInputs?.registerFailed !== true;

  if (tx.extraInputs?.commitUnconfirmed === true) {
    return { kind: 'submitted-unconfirmed', endpointPersisted, registered };
  }
  if (!endpointPersisted || !registered) {
    return { kind: 'completed-degraded', endpointPersisted, registered };
  }
  return { kind: 'confirmed' };
}

/**
 * The Activity/history claim for a completed rotation row, by verdict. The row
 * title used to be the frozen `displayMessage` snapshot; deriving it at render
 * keeps the claim attached to the evidence.
 */
export function rotationRowTitleKey(kind: RotationVerdictKind): string | undefined {
  switch (kind) {
    case 'confirmed':
    case 'completed-degraded':
      return 'guardianSwitchedRowTitle';
    case 'submitted-unconfirmed':
      return 'guardianSwitchSubmittedRowTitle';
    default:
      return undefined;
  }
}

/**
 * Status-chip rendering for a rotation row. `null` defers to the generic
 * status chip — only the claims the generic chip would get WRONG are overridden
 * (a submitted-unconfirmed row is Completed in the DB, which the generic chip
 * renders as a green "Confirmed").
 */
export function rotationChip(kind: RotationVerdictKind): { tone: 'pending'; labelKey: string } | null {
  return kind === 'submitted-unconfirmed' ? { tone: 'pending', labelKey: 'guardianSwitchSubmittedChip' } : null;
}
