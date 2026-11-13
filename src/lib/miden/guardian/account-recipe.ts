import type { Account } from '@miden-sdk/miden-sdk/lazy';
import {
  createMultisigAccount,
  type CreateAccountResult,
  type MultisigConfig,
  type ProcedureThreshold
} from '@openzeppelin/miden-multisig-client';

export const GUARDIAN_ACCOUNT_THRESHOLD = 1;

export const GUARDIAN_ACCOUNT_PROCEDURE_THRESHOLDS: readonly ProcedureThreshold[] = [
  {
    procedure: 'update_guardian',
    threshold: 2
  },
  // `update_procedure_threshold` edits the overrides, so it has to cost
  // at least as much as the strictest one it can lower. Left at the
  // account threshold of 1, the hardening above was decorative: either
  // single signer could drop `update_guardian` back to 1 and then
  // switch the guardian alone. Enforced by the builder (and by
  // `AuthMultisig::new` on the Rust side) since multisig-client 0.17,
  // which rejects the unguarded shape outright.
  {
    procedure: 'update_procedure_threshold',
    threshold: 2
  }
];

export const GUARDIAN_ACCOUNT_SEED_DOMAIN = 'miden-wallet/guardian-account-seed/v2';

/**
 * The builder's account seed: SHA-256 over the domain, the cold seed's length (4 bytes, big-endian), the cold
 * seed, then the hot and guardian key commitments (unprefixed lower-case hex). One-way, so the seed a new account
 * stores never carries key material. The builder can store this seed in the account itself, so it is bound to the
 * account's hot and guardian keys: known, it rebuilds only the account those keys were created with.
 */
export async function deriveGuardianAccountSeed(
  coldSeed: Uint8Array,
  hotCommitment: string,
  guardianCommitment: string
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const commitments = [hotCommitment, guardianCommitment].map(commitment => {
    const hex = commitment.replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('A Guardian account seed needs 32-byte hex key commitments');
    return encoder.encode(hex);
  });
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, coldSeed.length);
  const parts = [encoder.encode(GUARDIAN_ACCOUNT_SEED_DOMAIN), length, coldSeed, ...commitments];
  const input = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** What a Guardian account is built from; the same inputs build the same id and initial commitment. */
export interface GuardianAccountRecipe {
  hotCommitment: string;
  coldCommitment: string;
  guardianCommitment: string;
  initSeed: Uint8Array;
}

/** The config every Guardian account is created with, which a recovery rebuilds to check a served account. */
export function guardianAccountConfig(p: GuardianAccountRecipe & { guardianPublicKey?: string }): MultisigConfig {
  return {
    threshold: GUARDIAN_ACCOUNT_THRESHOLD,
    // Signer order is [hot, cold] by convention - the migration plan diagrams
    // and downstream role-routing code assume this layout.
    signerCommitments: [p.hotCommitment, p.coldCommitment],
    guardianCommitment: p.guardianCommitment,
    guardianPublicKey: p.guardianPublicKey,
    // No `guardianEnabled` since multisig-client 0.17: the builder now
    // rejects a config without a guardian commitment outright, so every
    // account it creates is guarded and the flag had nothing left to
    // select. We only ever passed `true`, so behavior is unchanged.
    storageMode: 'private',
    signatureScheme: 'ecdsa',
    seed: p.initSeed,
    procedureThresholds: GUARDIAN_ACCOUNT_PROCEDURE_THRESHOLDS.map(entry => ({ ...entry }))
  };
}

interface AccountInsertClient {
  accounts: { insert(options: { account: Account; overwrite?: boolean }): Promise<void> };
}

// `createMultisigAccount` declares a whole MidenClient but calls only `accounts.insert`. A method
// signature is checked bivariantly, so assigning it here is an unchecked assertion that the narrower
// client suffices, equivalent to a cast. The real-SDK node test (test/guardian-account-recipe.node.test.mjs)
// guards it at runtime by building through exactly this client.
interface AccountBuild {
  build(client: AccountInsertClient, config: MultisigConfig): Promise<CreateAccountResult>;
}

const storesNothing: AccountInsertClient = { accounts: { insert: async () => {} } };

/**
 * Builds the account `guardianAccountConfig` describes, as `MultisigClient.create` does, without
 * writing it to any store. The caller holds the WASM lock.
 */
export async function rebuildGuardianAccount(
  p: GuardianAccountRecipe
): Promise<{ accountIdHex: string; commitment: string }> {
  const builder: AccountBuild = { build: createMultisigAccount };
  const { account } = await builder.build(storesNothing, guardianAccountConfig(p));
  const read = <H extends { free(): void }>(handle: H, text: (h: H) => string): string => {
    try {
      return text(handle);
    } finally {
      handle.free();
    }
  };
  try {
    return {
      accountIdHex: read(account.id(), id => id.toString()),
      commitment: read(account.to_commitment(), word => word.toHex().replace(/^0x/i, '').toLowerCase())
    };
  } finally {
    account.free();
  }
}
