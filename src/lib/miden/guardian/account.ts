import { Account, AuthSecretKey, MidenClient, Word } from '@miden-sdk/miden-sdk/lazy';
import { EcdsaSigner, MultisigClient } from '@openzeppelin/miden-multisig-client';
import { Buffer } from 'buffer';

import { DEFAULT_GUARDIAN_ENDPOINT, GUARDIAN_OPTIONS, getRpcEndpointUrl } from 'lib/miden-chain/constants';
import * as secureHotKey from 'lib/secure-hot-key';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import type { GuardianProvider } from 'lib/shared/types';
import { WalletAccount } from 'lib/shared/types';

import { registerGuardianOrigin } from './native-http';
import { fetchFromStorage } from '../front/storage';

/**
 * Resolve the guardian operator endpoint for a Guardian account.
 *
 * Prefers the per-account `guardianEndpoint` (set at create/recovery time and
 * on switch-guardian) so accounts on different operators don't collide. Falls
 * back to the legacy global `GUARDIAN_URL_STORAGE_KEY` for records created
 * before the field existed, then to `DEFAULT_GUARDIAN_ENDPOINT`.
 */
export async function resolveGuardianEndpoint(account: WalletAccount): Promise<string> {
  if (account.guardianEndpoint) return account.guardianEndpoint;
  return (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || DEFAULT_GUARDIAN_ENDPOINT;
}

// Re-export the slot names from the package for reading account state
export const MULTISIG_SLOT_NAMES = {
  THRESHOLD_CONFIG: 'openzeppelin::multisig::threshold_config',
  SIGNER_PUBLIC_KEYS: 'openzeppelin::multisig::signer_public_keys',
  EXECUTED_TRANSACTIONS: 'openzeppelin::multisig::executed_transactions',
  PROCEDURE_THRESHOLDS: 'openzeppelin::multisig::procedure_thresholds'
} as const;

// GUARDIAN_SLOT_NAMES is module-private in @openzeppelin/miden-multisig-client
// (not re-exported), so we re-declare the slot names locally — same pattern
// as MULTISIG_SLOT_NAMES above.
export const GUARDIAN_SLOT_NAMES = {
  SELECTOR: 'openzeppelin::guardian::selector',
  PUBLIC_KEY: 'openzeppelin::guardian::public_key',
  SCHEME_ID: 'openzeppelin::guardian::scheme_id'
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
  // The guardian operator endpoint this account was registered with — persisted
  // onto the WalletAccount so runtime reads resolve per-account, not globally.
  guardianEndpoint: string;
}

/**
 * Signers live in the SIGNER_PUBLIC_KEYS storage map keyed by their index word
 * (matching @openzeppelin/miden-multisig-client's `signerMapKey`). The hot
 * signer is at index 0, the cold signer at index 1.
 */
const signerMapKey = (index: number): Word => new Word(new BigUint64Array([BigInt(index), 0n, 0n, 0n]));

/**
 * Read a signer's commitment from a Guardian account's storage.
 *
 * 3-key accounts store `[hot@0, cold@1]`; legacy single-key Guardian accounts
 * (feature #153) keep the cold/HD key alone at index 0. So for the cold lookup
 * we read index 1 and fall back to index 0 — otherwise activating a migrated
 * legacy account would read a non-existent index 1 and brick it.
 *
 * Commitments MUST be read BY KEY (`getMapItem(signerMapKey(i))`), not by
 * `getMapEntries()[i]` array position: getMapEntries returns the storage SMT's
 * iteration order (key-hash order), which is NOT the signer-index order, so a
 * positional read binds the wrong signer for roughly half of all accounts. The
 * SDK's own reader (multisig-client `AccountInspector.fromAccount`) reads by key
 * for the same reason.
 */
export async function getSignerDetailsFromAccount(account: Account, getCold = false): Promise<{ commitment: string }> {
  const storage = account.storage();

  const readSigner = (index: number): string | undefined => {
    const value = storage.getMapItem(MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS, signerMapKey(index));
    if (!value) return undefined;
    const hex = value.toHex();
    const unprefixed = hex.startsWith('0x') ? hex.slice(2) : hex;
    // An absent map entry reads back as the empty word (all zeros) in some SDK
    // builds — treat that as "no signer at this index".
    return /^0*$/.test(unprefixed) ? undefined : unprefixed;
  };

  const commitment = getCold ? (readSigner(1) ?? readSigner(0)) : readSigner(0);
  if (!commitment) {
    throw new Error('No signer commitment found in account storage');
  }

  return { commitment };
}

/**
 * Read the on-chain guardian operator key commitment from the
 * `openzeppelin::guardian::public_key` storage map (index 0) — a SEPARATE
 * slot from the multisig signer slots read by `getSignerDetailsFromAccount`.
 * Returns unprefixed hex, or undefined if absent / the empty (all-zero) word.
 */
export function getGuardianCommitmentFromAccount(account: Account): string | undefined {
  const storage = account.storage();
  const value = storage.getMapItem(GUARDIAN_SLOT_NAMES.PUBLIC_KEY, signerMapKey(0));
  if (!value) return undefined;
  const hex = value.toHex();
  const unprefixed = hex.startsWith('0x') ? hex.slice(2) : hex;
  return /^0*$/.test(unprefixed) ? undefined : unprefixed;
}

const PROVIDER_ID_MAP: Record<string, GuardianProvider> = {
  'open-zeppelin': 'open-zeppelin',
  gateway: 'gateway',
  'lambda-class': 'lambda-class'
};

/**
 * Reverse-map an endpoint URL to its built-in GUARDIAN_OPTIONS provider id;
 * 'custom' if the endpoint doesn't match any known provider; null if the
 * endpoint itself is null (account has no guardian).
 */
export function guardianProviderFromEndpoint(endpoint: string | null): GuardianProvider | null {
  if (!endpoint) return null;
  for (const option of GUARDIAN_OPTIONS) {
    for (const url of option.endpoint.values()) {
      if (url === endpoint) return PROVIDER_ID_MAP[option.id] ?? 'custom';
    }
  }
  return 'custom';
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
    // this is the JS fallback (serialized AuthSecretKey hex); on mobile it is
    // wrapped under SE (iOS) or Keystore/StrongBox (Android) inside the native
    // plugin and surfaces here only as opaque ciphertext.
    const hot = await secureHotKey.generateHotKey();

    // Get Guardian endpoint and initialize client
    const guardianEndpoint =
      guardianEndpointOverride ??
      (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) ??
      DEFAULT_GUARDIAN_ENDPOINT;

    registerGuardianOrigin(guardianEndpoint);
    const client = new MultisigClient(webClient, { guardianEndpoint, midenRpcEndpoint: getRpcEndpointUrl() });
    const { commitment: guardianCommitment, pubkey: guardianPubkey } = await client.guardianClient.getPubkey('ecdsa');
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
        seed: coldSeed,
        procedureThresholds: [
          {
            procedure: 'update_guardian',
            threshold: 2
          }
        ]
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
      },
      guardianEndpoint
    };
  } catch (e) {
    console.error('Error creating Guardian account:', e);
    // Preserve the original cause so callers can distinguish guardian-unreachable
    // from node/registration/WASM failures.
    throw new Error('Failed to create Guardian account', { cause: e });
  }
}
