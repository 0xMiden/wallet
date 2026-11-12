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

export const GUARDIAN_ACCOUNT_SEED_DOMAIN = 'miden-wallet/guardian-account-seed/v1';

/**
 * The builder's account seed, derived one-way from the cold key's seed so the
 * seed a new account stores never carries key material.
 */
export async function deriveGuardianAccountSeed(coldSeed: Uint8Array): Promise<Uint8Array> {
  const domain = new TextEncoder().encode(GUARDIAN_ACCOUNT_SEED_DOMAIN);
  const input = new Uint8Array(domain.length + coldSeed.length);
  input.set(domain);
  input.set(coldSeed, domain.length);
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
// signature is checked bivariantly, which lets it take the narrower client; the real-SDK node test
// (test/guardian-account-recipe.node.test.mjs) runs it on exactly this client.
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
