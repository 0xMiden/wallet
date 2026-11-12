import type { Account } from '@miden-sdk/miden-sdk/lazy';

import { GUARDIAN_RECOVERY_UNVERIFIED, GuardianRecoveryVerificationError } from '../sdk/guardian-recovery-errors';
import { getGuardianCommitmentFromAccount, getSignerDetailsFromAccount } from './account';

/** One account the Guardian served for a derived key, with the facts later checks compare. Commitments are unprefixed lower-case. */
export interface ServedGuardianState {
  bytes: Uint8Array;
  accountIdHex: string;
  nonce: bigint;
  isNew: boolean;
  commitment: string;
  hotCommitment?: string;
  coldCommitment?: string;
  guardianCommitment?: string;
}

const normalize = (hex: string) => hex.replace(/^0x/i, '').toLowerCase();

export const sameCommitment = (a: string, b: string): boolean => normalize(a) === normalize(b);

async function readSlot(read: () => Promise<{ commitment: string }>): Promise<string | undefined> {
  try {
    return normalize((await read()).commitment);
  } catch {
    return undefined;
  }
}

/** The caller holds the WASM lock. A slot that cannot be read is left undefined rather than failing the read. */
export async function readServedStateFacts(acc: Account, bytes: Uint8Array): Promise<ServedGuardianState> {
  const hotCommitment = await readSlot(() => getSignerDetailsFromAccount(acc, false));
  const coldCommitment = await readSlot(() => getSignerDetailsFromAccount(acc, true));
  const guardian = getGuardianCommitmentFromAccount(acc);
  return {
    bytes,
    accountIdHex: acc.id().toString(),
    nonce: acc.nonce().asInt(),
    isNew: acc.isNew(),
    commitment: normalize(acc.to_commitment().toHex()),
    hotCommitment,
    coldCommitment,
    guardianCommitment: guardian === undefined ? undefined : normalize(guardian)
  };
}

/** Refuses an account whose recovery signer is not the key the phrase derives at this index. */
export async function assertRecoverySignerMatches(acc: Account, coldCommitment: string): Promise<void> {
  const served = await readSlot(() => getSignerDetailsFromAccount(acc, true));
  if (served !== undefined && sameCommitment(served, coldCommitment)) return;
  const { getMessage } = await import('lib/i18n');
  throw new GuardianRecoveryVerificationError(GUARDIAN_RECOVERY_UNVERIFIED, getMessage('guardianRecoveryUnverified'));
}
