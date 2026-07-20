import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';
import { identifyGuardianOperator, verifyEndpointMatchesCommitment } from 'lib/miden/guardian/operator-map';
import type { GuardianSyncStatus } from 'lib/shared/types';

interface GuardianDriftVault {
  getAccount(pk: string): Promise<{ guardianOperatorCommitment?: string } | undefined>;
  setGuardianEndpoint(pk: string, endpoint: string): Promise<unknown>;
  setGuardianOperatorCommitment(pk: string, commitment: string): Promise<unknown>;
  setGuardianSyncStatus(pk: string, status: GuardianSyncStatus): Promise<unknown>;
}

/**
 * Detect an out-of-band guardian switch and reconcile the local endpoint.
 *
 * Compares the account's stored `guardianOperatorCommitment` baseline against
 * the commitment actually on-chain right now. If they match, nothing to do.
 * If they differ, tries to auto-resolve by matching the on-chain commitment
 * against the built-in operators (`identifyGuardianOperator`); on a match the
 * new endpoint + commitment are persisted and the account is back in sync,
 * otherwise the account is flagged `needs-user-input` for manual resolution.
 *
 * Returns the resulting sync status. The WASM account read is lock-guarded;
 * the built-in-operator HTTP probe runs outside the lock.
 */
export async function resolveGuardianDrift(
  vault: GuardianDriftVault,
  accountPublicKey: string
): Promise<GuardianSyncStatus> {
  const account = await vault.getAccount(accountPublicKey);
  if (!account) return 'in-sync';

  const onChain = await withWasmClientLock(async () => {
    const sdkAccount = await (await getMidenClient()).getAccount(accountPublicKey);
    return sdkAccount ? getGuardianCommitmentFromAccount(sdkAccount) : undefined;
  });
  if (!onChain) return 'in-sync';

  if (account.guardianOperatorCommitment && normalizedEqual(onChain, account.guardianOperatorCommitment)) {
    return 'in-sync';
  }

  await vault.setGuardianSyncStatus(accountPublicKey, 'resolving');
  const operator = await identifyGuardianOperator(onChain);
  if (operator) {
    await vault.setGuardianEndpoint(accountPublicKey, operator.endpoint);
    await vault.setGuardianOperatorCommitment(accountPublicKey, onChain);
    await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
    return 'in-sync';
  }

  await vault.setGuardianSyncStatus(accountPublicKey, 'needs-user-input');
  return 'needs-user-input';
}

function normalizedEqual(a: string, b: string): boolean {
  const n = (h: string) => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
  return n(a) === n(b);
}

export { verifyEndpointMatchesCommitment };
