import { v4 } from 'uuid';

import type { ITransaction, SubmitEvidenceFields } from '../db/types';

export interface CommittedGuardianEvidence {
  readonly transactionId: string;
  readonly finalCommitment: string;
}

interface CompletionIntent {
  readonly rowId: string;
  readonly attemptId: string;
  readonly operationBinding: string;
  readonly complete: (
    evidence: CommittedGuardianEvidence,
    assertCurrent: () => void,
    deadlineMs: number
  ) => Promise<void>;
  readonly timer: ReturnType<typeof setTimeout>;
  evidence?: CommittedGuardianEvidence;
  consumed?: true;
}

export const COMMITTED_GUARDIAN_FINISH_TIMEOUT_MS = 15_000;
// Bound orphaned attempts without making a long local proof renew its authority.
const ACTIVE_INTENT_LIMIT = 64;
const ACTIVE_INTENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const WORD = /^0x[0-9a-f]{64}$/i;
const intents = new Map<string, CompletionIntent>();

export function committedGuardianOperationBinding(row: ITransaction): string | undefined {
  if (row.type !== 'replace-hot-key' && row.type !== 'switch-guardian') return undefined;
  const extra: unknown = row.extraInputs;
  if (!extra || typeof extra !== 'object') return undefined;
  const target: unknown = Reflect.get(
    extra,
    row.type === 'replace-hot-key' ? 'newHotPublicKey' : 'newGuardianEndpoint'
  );
  return typeof target === 'string' && target ? JSON.stringify([row.type, row.accountId, target]) : undefined;
}

function retire(token: string): void {
  const intent = intents.get(token);
  if (intent) clearTimeout(intent.timer);
  intents.delete(token);
}

/** Issue only from the backend's access-checked, exact-row preparation. */
export function issueCommittedGuardianIntent(
  rowId: string,
  attemptId: string,
  operationBinding: string,
  complete: CompletionIntent['complete']
): string {
  for (const [token, intent] of intents) {
    if (intent.rowId === rowId) retire(token);
  }
  if (intents.size >= ACTIVE_INTENT_LIMIT) throw new Error('Too many active Guardian completions');
  // Row IDs are not capabilities. Only this random token crosses the public bridge.
  const token = v4();
  const timer = setTimeout(() => retire(token), ACTIVE_INTENT_TIMEOUT_MS);
  intents.set(token, { rowId, attemptId, operationBinding, complete, timer });
  return token;
}

/** The trusted row-bound pipeline calls this; no intercom binding operation exists. */
export function bindCommittedGuardianEvidence(
  rowId: string,
  attemptId: string,
  operationBinding: string | undefined,
  evidence: Pick<SubmitEvidenceFields, 'transactionId' | 'finalCommitment'> | undefined
): void {
  const transactionId = evidence?.transactionId;
  const finalCommitment = evidence?.finalCommitment;
  if (!transactionId || !finalCommitment || !WORD.test(transactionId) || !WORD.test(finalCommitment)) return;
  const bound = { transactionId: transactionId.toLowerCase(), finalCommitment: finalCommitment.toLowerCase() };
  for (const [token, intent] of intents) {
    if (intent.rowId !== rowId || intent.attemptId !== attemptId) continue;
    if (intent.operationBinding !== operationBinding) {
      retire(token);
      return;
    }
    if (
      intent.evidence &&
      (intent.evidence.transactionId !== bound.transactionId ||
        intent.evidence.finalCommitment !== bound.finalCommitment)
    ) {
      retire(token);
      return;
    }
    intent.evidence = bound;
  }
}

/** Claim once, retaining liveness checks while the committed proof and write are pending. */
export async function finishCommittedGuardianIntent(token: string, deadlineMs?: number): Promise<void> {
  const intent = intents.get(token);
  if (!intent?.evidence || intent.consumed) throw new Error('No bound active Guardian completion');
  if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs))) {
    retire(token);
    throw new Error('Invalid Guardian completion deadline');
  }
  const wallNow = Date.now();
  const budget =
    deadlineMs === undefined
      ? COMMITTED_GUARDIAN_FINISH_TIMEOUT_MS
      : Math.max(0, Math.min(COMMITTED_GUARDIAN_FINISH_TIMEOUT_MS, deadlineMs - wallNow));
  // Wall time shares the producer deadline across realms; elapsed time prevents
  // a system clock rollback from extending the server-side allowance.
  const deadline = wallNow + budget;
  const monotonicDeadline = performance.now() + budget;
  if (!Number.isFinite(budget) || budget <= 0) {
    retire(token);
    throw new Error('Guardian completion deadline expired');
  }
  // Retain the consumed entry so expiry, lock, or replacement can still revoke a
  // callback that is waiting on the node or account-write queue.
  intent.consumed = true;
  const assertCurrent = () => {
    if (intents.get(token) !== intent) throw new Error('Guardian completion intent retired');
    if (Date.now() >= deadline || performance.now() >= monotonicDeadline) {
      throw new Error('Guardian completion deadline expired');
    }
  };
  try {
    assertCurrent();
    await intent.complete(intent.evidence, assertCurrent, deadline);
  } finally {
    retire(token);
  }
}

export function clearCommittedGuardianIntent(rowId: string): void {
  for (const [token, intent] of intents) {
    if (intent.rowId === rowId) retire(token);
  }
}

export function clearCommittedGuardianIntents(): void {
  for (const token of intents.keys()) retire(token);
}
