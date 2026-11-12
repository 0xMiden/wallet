import type { Account } from '@miden-sdk/miden-sdk/lazy';
import { AccountInspector } from '@openzeppelin/miden-multisig-client';

import { getMessage } from 'lib/i18n';
import { sameCommitment } from 'lib/secure-hot-key/commitment';

import {
  GUARDIAN_RECOVERY_NETWORK_UNREACHABLE,
  GUARDIAN_RECOVERY_UNVERIFIED,
  GuardianRecoveryVerificationError
} from '../sdk/guardian-recovery-errors';
import { deriveGuardianAccountSeed, rebuildGuardianAccount } from './account-recipe';

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

/**
 * Reads a slot straight from the inspector: the shared readers in ./account turn every error into "no signer", a
 * trap included. A trap leaves the WASM client unusable, so it is rethrown for the enclosing lock hold to retire the
 * client; any other failure, a missing entry or an all-zero word leaves the slot undefined.
 */
function readSlot(read: () => unknown): string | undefined {
  let raw: unknown;
  try {
    raw = read();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) throw error;
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const commitment = normalize(raw);
  return /^0*$/.test(commitment) ? undefined : commitment;
}

/** Signers are stored `[hot, cold]`, the order account creation registers them in. */
const signerSlot = (acc: Account, cold: boolean) =>
  readSlot(() => AccountInspector.getSignerPublicKeyCommitments(acc)[cold ? 1 : 0]);

/** The caller holds the WASM lock. A slot that cannot be read is left undefined rather than failing the read. */
export async function readServedStateFacts(acc: Account, bytes: Uint8Array): Promise<ServedGuardianState> {
  const hotCommitment = signerSlot(acc, false);
  const coldCommitment = signerSlot(acc, true);
  const guardianCommitment = readSlot(() => AccountInspector.getGuardianPublicKeyCommitment(acc));
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
    guardianCommitment
  };
}

/** Refuses an account whose recovery signer is not the key the phrase derives at this index. */
export async function assertRecoverySignerMatches(acc: Account, coldCommitment: string): Promise<void> {
  const served = signerSlot(acc, true);
  if (served !== undefined && sameCommitment(served, coldCommitment)) return;
  throw new GuardianRecoveryVerificationError(GUARDIAN_RECOVERY_UNVERIFIED, getMessage('guardianRecoveryUnverified'));
}

/**
 * Refuses a never-deployed account unless the recovery phrase rebuilds it, with the same id and commitment, from
 * the matched index's cold seed and key and the served hot and guardian keys. Accounts created before the account
 * seed was derived were built from the cold seed itself, so that seed is tried second. Served keys the builder
 * refuses (an everyday key equal to the recovery key, a malformed commitment) are refused the same way; a trap
 * still reaches the lock.
 */
export async function assertUndeployedStateFromSeed(
  state: ServedGuardianState,
  coldSeed: Uint8Array,
  coldCommitment: string
): Promise<void> {
  const unverified = () =>
    new GuardianRecoveryVerificationError(GUARDIAN_RECOVERY_UNVERIFIED, getMessage('guardianRecoveryUnverified'));
  const orUnverified = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) throw error;
      throw unverified();
    }
  };
  const { hotCommitment, guardianCommitment } = state;
  if (hotCommitment === undefined || guardianCommitment === undefined) throw unverified();
  const [{ assertWasmHoldCurrent, withWasmClientLock }, accountSeed] = await Promise.all([
    import('../sdk/miden-client'),
    orUnverified(deriveGuardianAccountSeed(coldSeed, hotCommitment, guardianCommitment))
  ]);
  const rebuilt = await withWasmClientLock(
    async hold => {
      for (const initSeed of [accountSeed, coldSeed]) {
        const account = await orUnverified(
          rebuildGuardianAccount({ hotCommitment, coldCommitment, guardianCommitment, initSeed })
        );
        assertWasmHoldCurrent(hold, 'recover-guardian-rebuild after a rebuild');
        if (account.accountIdHex === state.accountIdHex && sameCommitment(account.commitment, state.commitment)) {
          return true;
        }
      }
      return false;
    },
    { label: 'recover-guardian-rebuild' }
  );
  if (!rebuilt) throw unverified();
}

export type AccountChainState = { kind: 'deployed'; commitment: string } | { kind: 'absent' } | { kind: 'unknown' };

/** The chain answer for one account read: a failed read is unknown, and a missing commitment is an absent account. */
function chainStateOf(read: { ok: true; state: { commitment?: string } } | { ok: false }): AccountChainState {
  if (!read.ok) return { kind: 'unknown' };
  return read.state.commitment === undefined
    ? { kind: 'absent' }
    : { kind: 'deployed', commitment: normalize(read.state.commitment) };
}

/**
 * Reads every distinct account on one node client. Takes no WASM lock and never rejects: a failed client or a
 * failed read is unknown for that id. An empty list builds no client.
 */
export async function readAccountChainStates(accountIds: readonly string[]): Promise<Map<string, AccountChainState>> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return new Map();
  const unknown = () =>
    new Map<string, AccountChainState>(ids.map(accountIdHex => [accountIdHex, { kind: 'unknown' }]));
  try {
    const { createNodeReads, RPC_READ_TIMEOUT_MS } = await import('../transaction/reconcile-reads');
    const reads = await createNodeReads();
    const chain = new Map<string, AccountChainState>();
    await Promise.all(
      ids.map(async accountIdHex => {
        try {
          chain.set(accountIdHex, chainStateOf(await reads.account(accountIdHex, undefined, RPC_READ_TIMEOUT_MS)));
        } catch {
          chain.set(accountIdHex, { kind: 'unknown' });
        }
      })
    );
    return chain;
  } catch {
    return unknown();
  }
}

/** One account, through the batch's single client. Takes no WASM lock and never rejects. */
export async function readAccountChainState(accountIdHex: string): Promise<AccountChainState> {
  const chain = await readAccountChainStates([accountIdHex]);
  return chain.get(accountIdHex) ?? { kind: 'unknown' };
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
