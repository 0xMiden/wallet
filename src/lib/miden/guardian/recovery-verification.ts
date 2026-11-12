import type { Account } from '@miden-sdk/miden-sdk/lazy';

import { getMessage } from 'lib/i18n';

import {
  GUARDIAN_RECOVERY_NETWORK_UNREACHABLE,
  GUARDIAN_RECOVERY_UNVERIFIED,
  GuardianRecoveryVerificationError
} from '../sdk/guardian-recovery-errors';
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
  } catch (error) {
    // A trap leaves the WASM client unusable; the enclosing lock hold must see it to retire the client.
    if (error instanceof WebAssembly.RuntimeError) throw error;
    return undefined;
  }
}

/** The caller holds the WASM lock. A slot that cannot be read is left undefined rather than failing the read. */
export async function readServedStateFacts(acc: Account, bytes: Uint8Array): Promise<ServedGuardianState> {
  const hotCommitment = await readSlot(() => getSignerDetailsFromAccount(acc, false));
  const coldCommitment = await readSlot(() => getSignerDetailsFromAccount(acc, true));
  const guardian = getGuardianCommitmentFromAccount(acc);
  const readHandle = <H extends { free(): void }, T>(handle: H, read: (h: H) => T): T => {
    try {
      return read(handle);
    } finally {
      handle.free();
    }
  };
  const accountId = readHandle(acc.id(), id => id.toString());
  const nonce = readHandle(acc.nonce(), felt => felt.asInt());
  const commitment = readHandle(acc.to_commitment(), word => normalize(word.toHex()));
  return {
    bytes,
    accountIdHex: accountId,
    nonce,
    isNew: acc.isNew(),
    commitment,
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

export type AccountChainState = { kind: 'deployed'; commitment: string } | { kind: 'absent' } | { kind: 'unknown' };

/** Reads the account's commitment from the network. Takes no WASM lock and never rejects. */
export async function readAccountChainState(accountIdHex: string): Promise<AccountChainState> {
  try {
    const { createNodeReads, RPC_READ_TIMEOUT_MS } = await import('../transaction/reconcile-reads');
    const read = await (await createNodeReads()).account(accountIdHex, undefined, RPC_READ_TIMEOUT_MS);
    if (!read.ok) return { kind: 'unknown' };
    return read.state.commitment === undefined
      ? { kind: 'absent' }
      : { kind: 'deployed', commitment: normalize(read.state.commitment) };
  } catch {
    return { kind: 'unknown' };
  }
}

export type ServedStateVerdict = 'verified' | 'undeployed' | 'mismatch' | 'unverified' | 'unknown';

export function judgeServedState(
  state: Pick<ServedGuardianState, 'isNew' | 'commitment'>,
  chain: AccountChainState
): ServedStateVerdict {
  if (chain.kind === 'unknown') return 'unknown';
  if (chain.kind === 'deployed') return sameCommitment(state.commitment, chain.commitment) ? 'verified' : 'mismatch';
  // The Guardian reports transactions the chain has never seen for anything but a fresh account.
  return state.isNew ? 'undeployed' : 'unverified';
}

/** The entries safe to restore, or the refusal that explains why none of them are. */
export function selectAdoptable<
  T extends { state: ServedGuardianState; verdict: Exclude<ServedStateVerdict, 'undeployed'> }
>(judged: readonly T[]): T[] {
  const refuse = (code: GuardianRecoveryVerificationError['code'], key: string): never => {
    throw new GuardianRecoveryVerificationError(code, getMessage(key));
  };
  if (judged.some(entry => entry.verdict === 'unverified')) {
    refuse(GUARDIAN_RECOVERY_UNVERIFIED, 'guardianRecoveryUnverified');
  }
  const verifiedIds = new Set(judged.filter(e => e.verdict === 'verified').map(e => e.state.accountIdHex));
  const unmatched = judged.filter(e => !verifiedIds.has(e.state.accountIdHex));
  const hasAllMismatch = unmatched.some(e =>
    judged.filter(o => o.state.accountIdHex === e.state.accountIdHex).every(o => o.verdict === 'mismatch')
  );
  if (hasAllMismatch) refuse(GUARDIAN_RECOVERY_UNVERIFIED, 'guardianRecoveryBehindNetwork');
  if (unmatched.some(e => e.verdict === 'unknown')) {
    refuse(GUARDIAN_RECOVERY_NETWORK_UNREACHABLE, 'guardianRecoveryNetworkUnreachable');
  }
  return judged.filter(e => verifiedIds.has(e.state.accountIdHex) && e.verdict === 'verified');
}
