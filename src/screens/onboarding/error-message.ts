import { MAINNET_ACCESS_CODE_REJECTED } from 'lib/miden/back/defaults';
import {
  GUARDIAN_ACCOUNT_NOT_FOUND,
  GUARDIAN_RECOVERY_NETWORK_UNREACHABLE,
  GUARDIAN_RECOVERY_UNVERIFIED
} from 'lib/miden/sdk/guardian-recovery-errors';

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

/**
 * Whether a seed recovery refused the accounts the Guardian served. The refusal travels as a
 * string `code` on the flattened `PublicError`, and its message is already the text to show.
 */
export function isGuardianRecoveryRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code === GUARDIAN_RECOVERY_UNVERIFIED || error.code === GUARDIAN_RECOVERY_NETWORK_UNREACHABLE)
  );
}

/** Whether a wallet setup failed because the mainnet node refused its access code, by the same `code` route. */
export function isMainnetAccessCodeRejected(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === MAINNET_ACCESS_CODE_REJECTED;
}
