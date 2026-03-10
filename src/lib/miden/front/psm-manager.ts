import { MultisigService } from 'lib/miden/psm';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { MULTISIG_SLOT_NAMES } from '../psm/account';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
/**
 * Create a MultisigService for the given PSM account.
 */
export async function getOrCreateMultisigService(
  accountPublicKey: string,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>
): Promise<MultisigService> {
  // Verify this is a PSM account using Zustand store
  const accounts = useWalletStore.getState().accounts;
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  if (!account || account.type !== WalletType.Psm) {
    throw new Error('Account is not a PSM account');
  }

  // Get the Account object and WebClient from Miden client
  const { sdkAccount } = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    const sdkAccount = await midenClient.getAccount(accountPublicKey);
    return { sdkAccount };
  });

  if (!sdkAccount) {
    throw new Error('Account not found in local storage');
  }

  const mapEntries = sdkAccount.storage().getMapEntries(MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS);
  if (!mapEntries) {
    throw new Error('No signer public keys found in account storage');
  }

  const commitment = mapEntries[0].value.slice(2);
  if (!commitment) {
    throw new Error('Commitment not found in account storage');
  }

  // Get the actual public key from the public key commitment
  const publicKey = await useWalletStore.getState().getPublicKeyForCommitment(commitment);

  // Initialize MultisigService with the account, public key, commitment, sign function, and webClient
  const service = await MultisigService.init(sdkAccount, `0x${publicKey}`, `0x${commitment}`, signCallback);

  return service;
}

/**
 * Check if an account is a PSM account.
 */
export function isPsmAccount(accountPublicKey: string): boolean {
  const accounts = useWalletStore.getState().accounts;
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  return account?.type === WalletType.Psm;
}
