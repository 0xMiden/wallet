/** The `code` a Guardian lookup's definite "no account here" answer carries across the intercom. */
export const GUARDIAN_ACCOUNT_NOT_FOUND = 'GUARDIAN_ACCOUNT_NOT_FOUND';

/**
 * `recoverGuardianAccountsBySeed` throws this error when the scan is complete
 * and the operator has no account for a derived cold key. The error is a
 * definite "nothing here" answer. It is not a failed lookup.
 *
 * The `code` is what lets the UI tell this answer from a failed lookup after
 * the backend flattens the class away into a `PublicError`.
 */
export class NoGuardianAccountsFoundError extends Error {
  readonly code = GUARDIAN_ACCOUNT_NOT_FOUND;

  constructor(message = 'No Guardian accounts found at this guardian endpoint for this seed') {
    super(message);
    this.name = 'NoGuardianAccountsFoundError';
  }
}
