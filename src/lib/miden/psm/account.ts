import { Account, AuthSecretKey, WebClient } from '@miden-sdk/miden-sdk';
import { FalconSigner, MultisigClient } from '@openzeppelin/miden-multisig-client';

import { DEFAULT_PSM_ENDPOINT } from 'lib/miden-chain/constants';
import { PSM_URL_STORAGE_KEY } from 'lib/settings/constants';

import { fetchFromStorage } from '../front';

// Re-export the slot names from the package for reading account state
export const MULTISIG_SLOT_NAMES = {
  THRESHOLD_CONFIG: 'openzeppelin::multisig::threshold_config',
  SIGNER_PUBLIC_KEYS: 'openzeppelin::multisig::signer_public_keys',
  EXECUTED_TRANSACTIONS: 'openzeppelin::multisig::executed_transactions',
  PROCEDURE_THRESHOLDS: 'openzeppelin::multisig::procedure_thresholds'
} as const;

/**
 * Extract signer commitment and public key from a PSM account's storage.
 */
export async function getSignerDetailsFromAccount(
  account: Account,
  getPublicKeyForCommitment: (commitment: string) => Promise<string>
): Promise<{ commitment: string; publicKey: string }> {
  const mapEntries = account.storage().getMapEntries(MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS);
  if (!mapEntries) {
    throw new Error('No signer public keys found in account storage');
  }

  const commitment = mapEntries[0].value.slice(2);
  if (!commitment) {
    throw new Error('Commitment not found in account storage');
  }

  const publicKey = await getPublicKeyForCommitment(commitment);
  return { commitment, publicKey };
}

/**
 * Create a PSM (Private State Manager) account using the MultisigClient.
 *
 * This creates a 1-of-1 multisig account with PSM signature verification enabled.
 * The account is registered with the PSM backend and the secret key is stored locally.
 *
 * @param webClient - The Miden WebClient instance
 * @param seed - Optional seed for key derivation (random if not provided)
 * @returns The created Account
 */
export async function createPsmAccount(webClient: WebClient, seed?: Uint8Array): Promise<Account> {
  if (!seed) {
    seed = crypto.getRandomValues(new Uint8Array(32));
  }

  try {
    // Generate the signer secret key from seed
    const sk = AuthSecretKey.rpoFalconWithRNG(seed);
    const signerCommitment = sk.publicKey().toCommitment();

    // Get PSM endpoint and initialize client
    const guardianEndpoint = (await fetchFromStorage<string>(PSM_URL_STORAGE_KEY)) || DEFAULT_PSM_ENDPOINT;
    const client = new MultisigClient(webClient, { guardianEndpoint });
    const { commitment, pubkey } = await client.guardianClient.getPubkey();
    // Create the multisig account using the package utility
    const multisig = await client.create(
      {
        threshold: 1,
        signerCommitments: [signerCommitment.toHex()],
        guardianCommitment: commitment,
        guardianPublicKey: pubkey,
        guardianEnabled: true,
        storageMode: 'private',
        signatureScheme: 'falcon',
        seed
      },
      new FalconSigner(sk)
    );
    await multisig.registerOnGuardian();
    // Sync state with the node
    await webClient.syncState();

    // Store the secret key in WebStore for signing
    await webClient.addAccountSecretKeyToWebStore(multisig.account.id(), sk);

    console.log('PSM account created:', multisig.account.id().toString());

    return multisig.account;
  } catch (e) {
    console.error('Error creating PSM account:', e);
    throw new Error('Failed to create PSM account');
  }
}
