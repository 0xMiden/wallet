/**
 * Thrown by `recoverGuardianAccountsBySeed` when the scan completes and the
 * operator holds no account for any derived cold key. A definitive "nothing
 * here" answer, distinct from a lookup that failed: `Vault.spawn` moves on to
 * the legacy derivation only on this error and aborts on every other one.
 */
export class NoGuardianAccountsFoundError extends Error {
  constructor() {
    super('No Guardian accounts found at this guardian endpoint for this seed');
    this.name = 'NoGuardianAccountsFoundError';
  }
}
