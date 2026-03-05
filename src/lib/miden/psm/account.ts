import { Account, AuthSecretKey, WebClient } from '@miden-sdk/miden-sdk';
import { createMultisigAccount, MultisigClient } from '@openzeppelin/miden-multisig-client';

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
    const psmEndpoint = (await fetchFromStorage<string>(PSM_URL_STORAGE_KEY)) || DEFAULT_PSM_ENDPOINT;
    const client = new MultisigClient(webClient, { psmEndpoint });
    const { psmCommitment, psmPublicKey } = await client.initialize('falcon');

    console.log('Creating PSM account with PSM commitment:', psmCommitment);

    // Create the multisig account using the package utility
    const { account } = await createMultisigAccount(webClient, {
      threshold: 1,
      signerCommitments: [signerCommitment.toHex()],
      psmCommitment,
      psmPublicKey,
      psmEnabled: true,
      storageMode: 'public',
      signatureScheme: 'falcon'
    });

    // Sync state with the node
    await webClient.syncState();

    // Store the secret key in WebStore for signing
    await webClient.addAccountSecretKeyToWebStore(account.id(), sk);

    console.log('PSM account created:', account.id().toString());

    return account;
  } catch (e) {
    console.error('Error creating PSM account:', e);
    throw new Error('Failed to create PSM account');
  }
}
