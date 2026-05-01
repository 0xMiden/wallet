import { Account, AuthSecretKey, MidenClient } from '@miden-sdk/miden-sdk/lazy';
import { EcdsaSigner, MultisigClient } from '@openzeppelin/miden-multisig-client';
import { Buffer } from 'buffer';

import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import * as secureHotKey from 'lib/secure-hot-key';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';

import { fetchFromStorage } from '../front/storage';

// Re-export the slot names from the package for reading account state
export const MULTISIG_SLOT_NAMES = {
  THRESHOLD_CONFIG: 'openzeppelin::multisig::threshold_config',
  SIGNER_PUBLIC_KEYS: 'openzeppelin::multisig::signer_public_keys',
  EXECUTED_TRANSACTIONS: 'openzeppelin::multisig::executed_transactions',
  PROCEDURE_THRESHOLDS: 'openzeppelin::multisig::procedure_thresholds'
} as const;

/**
 * Material the wallet must persist after a Guardian account is created.
 * Hot is held outside the SDK keystore (secure-hot-key facade); cold lives
 * inside the SDK keystore *and* is mirrored to a separate vault entry so
 * role-aware signWord (Phase 3) can route by storage entity.
 */
export interface CreatedGuardianKeys {
  hotPublicKey: string; // serialize().slice(1) hex
  coldPublicKey: string; // serialize().slice(1) hex
  hotCiphertext: string; // opaque blob from the secure-hot-key facade
  coldSecretKeyHex: string; // serialized AuthSecretKey hex (for cold-mirror storage)
}

export interface CreatedGuardianAccount {
  account: Account;
  keys: CreatedGuardianKeys;
}

/**
 * Extract signer commitment and public key from a Guardian account's storage.
 */
export async function getSignerDetailsFromAccount(
  account: Account,
  getPublicKeyForCommitment: (commitment: string) => Promise<string>
): Promise<{ commitment: string; publicKey: string }> {
  const mapEntries = account.storage().getMapEntries(MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS);
  if (!mapEntries) {
    throw new Error('No signer public keys found in account storage');
  }

  if (!mapEntries[0]) {
    throw new Error('No signer commitments found in account storage');
  }

  const commitment = mapEntries[0].value.slice(2);
  if (!commitment) {
    throw new Error('Commitment not found in account storage');
  }

  const publicKey = await getPublicKeyForCommitment(commitment);
  return { commitment, publicKey };
}

/**
 * Create a 3-key Guardian account: a random hot ECDSA key (held outside the
 * WASM keystore, behind the secure-hot-key facade), an HD-derived cold ECDSA
 * key (held inside the keystore, used for rotation/recovery), and the external
 * guardian co-signer. Default threshold 1 — hot OR cold + guardian satisfies
 * routine operations; cold-only routing for rotation procedures is enforced
 * client-side (see Phase 0 in the migration plan).
 *
 * @param webClient - The Miden WebClient instance.
 * @param coldSeed - HD-derived seed for the cold key. Random if absent (only
 *   appropriate for tests / non-recoverable flows).
 * @param skipRegistration - Skip guardian registration (used by the import path).
 * @param guardianEndpointOverride - Force a specific guardian URL for pubkey
 *   derivation. Account ID is a content hash that includes the guardian pubkey
 *   baked into storage, so the import flow passes `DEFAULT_GUARDIAN_ENDPOINT`
 *   to reproduce the ID the account originally had.
 */
export async function createGuardianAccount(
  webClient: MidenClient,
  coldSeed?: Uint8Array,
  skipRegistration: boolean = false,
  guardianEndpointOverride?: string
): Promise<CreatedGuardianAccount> {
  if (!coldSeed) {
    coldSeed = crypto.getRandomValues(new Uint8Array(32));
  }

  try {
    // Cold key — HD-derived, lives in SDK keystore, used for cold-routed flows
    // (rotation, recovery). EcdsaSigner gets the cold AuthSecretKey directly so
    // the create-time deploy proposal is signed by cold; the on-chain account
    // therefore binds to the cold commitment via the deploy signature in
    // addition to the storage-slot binding.
    const coldSk = AuthSecretKey.ecdsaWithRNG(coldSeed);
    const coldPublicKeyObj = coldSk.publicKey();
    const coldCommitmentHex = coldPublicKeyObj.toCommitment().toHex();
    const coldPublicKey = Buffer.from(coldPublicKeyObj.serialize().slice(1)).toString('hex');
    const coldSecretKeyHex = Buffer.from(coldSk.serialize()).toString('hex');

    // Hot key — random, held outside the SDK keystore. On extension/desktop
    // this is the JS fallback (serialized AuthSecretKey hex); on mobile this
    // will be ECIES-wrapped under SE/StrongBox once Phase 4 lands.
    const hot = await secureHotKey.generateHotKey();

    // Get Guardian endpoint and initialize client
    const guardianEndpoint =
      guardianEndpointOverride ??
      (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) ??
      DEFAULT_GUARDIAN_ENDPOINT;
    console.log('Using Guardian endpoint:', guardianEndpoint);

    const client = new MultisigClient(webClient, { guardianEndpoint });
    const { commitment: guardianCommitment, pubkey: guardianPubkey } = await client.guardianClient.getPubkey();

    // Signer order is [hot, cold] by convention — the migration plan diagrams
    // and downstream role-routing code assume this layout.
    const multisig = await client.create(
      {
        threshold: 1,
        signerCommitments: [hot.commitmentHex, coldCommitmentHex],
        guardianCommitment,
        guardianPublicKey: guardianPubkey,
        guardianEnabled: true,
        storageMode: 'private',
        signatureScheme: 'ecdsa',
        seed: coldSeed
      },
      new EcdsaSigner(coldSk)
    );

    if (!skipRegistration) {
      await multisig.registerOnGuardian();
    }
    await webClient.sync();

    // Cold goes through the standard SDK keystore so the WASM client can sign
    // with it on demand; the existing insertKeyCallback wraps it under the
    // vault key and stores it at accAuthSecretKeyStrgKey(coldPublicKey).
    // Hot is intentionally NOT inserted here — vault.ts persists the
    // returned hot ciphertext separately under its own envelope.
    await webClient.keystore.insert(multisig.account.id(), coldSk);

    console.log('Guardian account created:', multisig.account.id().toString());

    return {
      account: multisig.account,
      keys: {
        hotPublicKey: hot.publicKeyHex,
        coldPublicKey,
        hotCiphertext: hot.ciphertext,
        coldSecretKeyHex
      }
    };
  } catch (e) {
    console.log(e);
    console.error('Error creating Guardian account:', e);
    throw new Error('Failed to create Guardian account');
  }
}
