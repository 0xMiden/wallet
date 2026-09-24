/**
 * `recoverGuardianAccountsBySeed` throws this error when the scan is complete
 * and the operator has no account for a derived cold key. The error is a
 * definite "nothing here" answer. It is not a failed lookup.
 *
 * `Vault.spawn` scans the seed under each derivation scheme and merges the
 * results. This error from one scheme means that the scheme has no accounts.
 * The spawn records an empty result for it and continues with the next
 * scheme. Each other error stops the spawn. If each scheme gives this error,
 * the spawn throws this error again.
 */
export class NoGuardianAccountsFoundError extends Error {
  constructor() {
    super('No Guardian accounts found at this guardian endpoint for this seed');
    this.name = 'NoGuardianAccountsFoundError';
  }
}
