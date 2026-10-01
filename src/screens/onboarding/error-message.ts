import { GUARDIAN_ACCOUNT_NOT_FOUND } from 'lib/miden/sdk/guardian-recovery-errors';

/**
 * The text of a registration failure, for a screen that shows it verbatim.
 *
 * Deliberately not a friendly rewrite: registration spans hardware protection,
 * the selected Guardian, wallet storage and the network, and the original
 * message is the only thing that tells a tester, or a bug report, which stage
 * failed. Confirmation renders it as selectable text for that reason.
 *
 * Returns undefined when the failure carries no text of its own, so the caller
 * shows translated fallback copy rather than an empty or English-only message.
 */
export function errorToMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // A cycle or a BigInt: nothing usable to show.
    }
  }
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  return undefined;
}

/**
 * Whether a Guardian lookup failure is the operator's definite "no account here" answer, carried
 * across the intercom as a `code` on the error rather than a distinguishable class (the backend
 * flattens thrown classes into a plain `PublicError`).
 */
export function isGuardianNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === GUARDIAN_ACCOUNT_NOT_FOUND;
}
