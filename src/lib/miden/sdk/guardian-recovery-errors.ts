/**
 * `recoverGuardianAccountsBySeed` throws this error when the scan is complete
 * and the operator has no account for a derived cold key. The error is a
 * definite "nothing here" answer. It is not a failed lookup.
 */
export class NoGuardianAccountsFoundError extends Error {
  constructor() {
    super('No Guardian accounts found at this guardian endpoint for this seed');
    this.name = 'NoGuardianAccountsFoundError';
  }
}
