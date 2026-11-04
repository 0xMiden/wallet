import {
  COMPACT_ABI,
  type CompactRequest,
  type EpochIntentSDK,
  type EpochIntentSDKConfig,
  type GetForcedWithdrawalStatusResult
} from '@epoch-protocol/epoch-intents-sdk';
import { buildCreateAllocationRequest } from '@epoch-protocol/epoch-intents-sdk/dist/sdk/quote.js';
import { getCompactData } from '@epoch-protocol/epoch-intents-sdk/dist/services/compact-data.js';
import { resolveCompactAddress } from '@epoch-protocol/epoch-intents-sdk/dist/services/shared.js';
import { type Address, type Hex, isAddress, isHex } from 'viem';

import { registerPendingBridgeIn } from 'lib/miden/activity/bridge-in';
import type { IBridgedReceiveExtraInputs, IEpochLockedDeposit } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getEpochAllocatorUrl } from 'lib/remote-config/values';
import { waitForEvmReceipt } from 'lib/walletconnect/receipt';

import { epochLockedDepositState, nowSec, readCompactLockBalance } from './bridge-in-lock';
import { buildEpochWalletClient, epochChain, getEvmConnection, switchWebWalletChain } from './client';
import { getEpochSdk } from './sdk';

/** Why a recovery action refused to run. The screen shows a sentence for each reason. */
export type LockedDepositErrorReason =
  | 'notRecoverable'
  | 'walletDisconnected'
  | 'wrongAccount'
  | 'wrongChain'
  | 'withdrawalNotStarted'
  | 'withdrawalNotDue'
  | 'depositMissing'
  | 'lockMismatch';

export class LockedDepositError extends Error {
  readonly reason: LockedDepositErrorReason;

  constructor(reason: LockedDepositErrorReason, message: string) {
    super(message);
    this.name = 'LockedDepositError';
    this.reason = reason;
  }
}

interface LockedDepositRow {
  inputs: IBridgedReceiveExtraInputs;
  lock: IEpochLockedDeposit;
  sponsor: Address;
}

/** Read row `txId` and refuse when it does not hold a locked deposit that this wallet can recover. */
async function readLockedDeposit(txId: string): Promise<LockedDepositRow> {
  const row = await Repo.transactions.get(txId);
  const inputs: IBridgedReceiveExtraInputs | undefined = row?.type === 'bridged-receive' ? row.extraInputs : undefined;
  const lock = inputs?.epochLockedDeposit;
  if (
    row === undefined ||
    inputs === undefined ||
    lock === undefined ||
    epochLockedDepositState(lock, inputs.phase, row.restoredFromBackup === true) !== 'locked' ||
    !isAddress(lock.sponsorAddress)
  ) {
    throw new LockedDepositError('notRecoverable', 'This deposit cannot be recovered from this wallet.');
  }
  return { inputs, lock, sponsor: lock.sponsorAddress };
}

/**
 * The SDK on the connected EVM wallet. Refuse when no wallet is connected or when it is not the sponsor: only the
 * sponsor can register or withdraw the deposit. Move a web wallet to the deposit chain first.
 */
async function connectSponsorSdk(lock: IEpochLockedDeposit, allocatorUrl: string): Promise<EpochIntentSDK> {
  let connection = await getEvmConnection();
  if (!connection.address) {
    throw new LockedDepositError('walletDisconnected', 'Connect the EVM wallet that made this deposit.');
  }
  if (connection.address.toLowerCase() !== lock.sponsorAddress.toLowerCase()) {
    throw new LockedDepositError('wrongAccount', 'The connected EVM wallet did not make this deposit.');
  }
  if (!connection.isNative && connection.chainId !== lock.chainId) {
    await switchWebWalletChain(lock.chainId);
    connection = await getEvmConnection();
    if (connection.chainId !== lock.chainId) {
      throw new LockedDepositError('wrongChain', 'Switch the EVM wallet to the network of this deposit.');
    }
  }
  const sdk = await getEpochSdk({ chainId: lock.chainId, allocatorUrl });
  if (!sdk) throw new LockedDepositError('walletDisconnected', 'Connect the EVM wallet that made this deposit.');
  return sdk;
}

/** Unix seconds from which the sponsor can withdraw, when The Compact reports a withdrawal in progress. */
export function withdrawableAtOf(result: GetForcedWithdrawalStatusResult): number | undefined {
  switch (result.status) {
    case 'Pending':
    case 'Enabled':
      return Number(result.enabledAt);
    case 'Disabled':
    default:
      return undefined;
  }
}

type LockedDepositPatch = Partial<
  Pick<IEpochLockedDeposit, 'withdrawEnabledAt' | 'withdrawableAt' | 'withdrawTxHash' | 'withdrawnAt'>
>;

/**
 * Merge withdrawal progress into the locked deposit of row `id`. Write nothing when the row is not a locked deposit
 * (a retry or a withdrawal finished it, or it was restored). Return whether the row changed.
 */
export async function patchEpochLockedDeposit(id: string, patch: LockedDepositPatch): Promise<boolean> {
  let written = false;
  await Repo.transactions.where({ id }).modify(tx => {
    const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
    const lock = inputs?.epochLockedDeposit;
    if (tx.type !== 'bridged-receive' || inputs === undefined || lock === undefined) return;
    if (epochLockedDepositState(lock, inputs.phase, tx.restoredFromBackup === true) !== 'locked') return;
    tx.extraInputs = { ...inputs, epochLockedDeposit: { ...lock, ...patch } };
    written = true;
  });
  return written;
}

/**
 * Move a locked row back into delivery after a retry registered its deposit again under `intentNonce`. The row then
 * continues as a normal bridge-in: the reconciler polls the intent, and the consume of its note completes the row.
 * Return whether the row changed.
 */
export async function markEpochLockedDepositReallocated(
  id: string,
  intentNonce: string,
  epochAllocatorUrl: string
): Promise<boolean> {
  let written = false;
  await Repo.transactions.where({ id }).modify(tx => {
    const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
    const lock = inputs?.epochLockedDeposit;
    if (tx.type !== 'bridged-receive' || inputs === undefined || lock === undefined) return;
    if (epochLockedDepositState(lock, inputs.phase, tx.restoredFromBackup === true) !== 'locked') return;
    tx.extraInputs = {
      ...inputs,
      phase: 'delivering',
      intentNonce,
      epochAllocatorUrl,
      error: undefined,
      errorId: undefined,
      epochLockedDeposit: { ...lock, reallocatedAt: nowSec(), withdrawEnabledAt: undefined, withdrawableAt: undefined }
    };
    tx.error = undefined;
    tx.rawError = undefined;
    written = true;
  });
  return written;
}

/**
 * Start the forced withdrawal of a locked deposit from the sponsor's wallet, then record when it is due. The Compact
 * lets the sponsor withdraw only after the lock's reset period. Return that time in unix seconds, or undefined when
 * the chain does not report it yet.
 */
export async function startLockedDepositWithdrawal(txId: string): Promise<number | undefined> {
  const { inputs, lock, sponsor } = await readLockedDeposit(txId);
  const sdk = await connectSponsorSdk(lock, inputs.epochAllocatorUrl ?? getEpochAllocatorUrl());
  let status = await sdk.getForcedWithdrawalStatus(sponsor, lock.lockId);
  if (status.status === 'Disabled') {
    await sdk.initateDepositWithdrawal(lock.lockId);
    status = await sdk.getForcedWithdrawalStatus(sponsor, lock.lockId);
  }
  const withdrawableAt = withdrawableAtOf(status);
  await patchEpochLockedDeposit(txId, { withdrawEnabledAt: lock.withdrawEnabledAt ?? nowSec(), withdrawableAt });
  return withdrawableAt;
}

/**
 * Withdraw a locked deposit to the sponsor once its forced withdrawal is due. Withdraw at most what the lock still
 * holds. Return the withdrawal transaction hash.
 */
export async function finishLockedDepositWithdrawal(txId: string): Promise<string> {
  const { inputs, lock, sponsor } = await readLockedDeposit(txId);
  const sdk = await connectSponsorSdk(lock, inputs.epochAllocatorUrl ?? getEpochAllocatorUrl());
  const status = await sdk.getForcedWithdrawalStatus(sponsor, lock.lockId);
  switch (status.status) {
    case 'Disabled':
      throw new LockedDepositError('withdrawalNotStarted', 'Start the withdrawal first.');
    case 'Pending':
      await patchEpochLockedDeposit(txId, { withdrawableAt: withdrawableAtOf(status) });
      throw new LockedDepositError('withdrawalNotDue', 'The withdrawal is not due yet.');
    case 'Enabled':
    default:
      break;
  }
  const balance = await readCompactLockBalance(sdk, sponsor, lock.tokenAddress);
  if (balance === undefined || balance.lockId !== lock.lockId || balance.balance <= 0n) {
    throw new LockedDepositError('depositMissing', 'The Compact no longer holds this deposit.');
  }
  const deposited = BigInt(lock.amount);
  const amount = balance.balance < deposited ? balance.balance : deposited;
  const result = await sdk.withdrawToken(lock.lockId, sponsor, amount.toString());
  await patchEpochLockedDeposit(txId, { withdrawTxHash: result.transactionHash, withdrawnAt: nowSec() });
  return result.transactionHash;
}

interface RegisteredCompact {
  compactData: unknown;
  witnessTypeString: string;
  claimHash: Hex;
  typehash: Hex;
  lockId: string;
}

/** Read the fields that the retry needs from the SDK's untyped `getCompactData` result. */
export function readCompactData(value: unknown): RegisteredCompact | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const compactData: unknown = Reflect.get(value, 'compactData');
  const witnessTypeString: unknown = Reflect.get(value, 'witnessTypeString');
  const claimHash: unknown = Reflect.get(value, 'claimHash');
  const typehash: unknown = Reflect.get(value, 'typehash');
  if (typeof compactData !== 'object' || compactData === null) return undefined;
  const id: unknown = Reflect.get(compactData, 'id');
  if (typeof witnessTypeString !== 'string' || !isHex(claimHash) || !isHex(typehash)) return undefined;
  if (typeof id !== 'bigint' && typeof id !== 'string') return undefined;
  return { compactData, witnessTypeString, claimHash, typehash, lockId: id.toString() };
}

/**
 * Build a compact over the locked amount with a fresh nonce from the allocator, and register its claim hash on The
 * Compact from the sponsor's wallet. The allocator accepts an allocation only for a claim that is registered on chain,
 * and the deposit registered only the claim of the refused nonce. No tokens move.
 */
async function registerCompactAgain(
  lock: IEpochLockedDeposit,
  sponsor: Address,
  allocatorUrl: string
): Promise<CompactRequest> {
  const walletClient = await buildEpochWalletClient(sponsor, { chainOverride: lock.chainId });
  const config: EpochIntentSDKConfig = { apiBaseUrl: allocatorUrl, walletClient };
  const compact = readCompactData(
    await getCompactData(config, {
      isNative: lock.isNative,
      sponsorAddress: sponsor,
      taskTypeString: lock.taskTypeString,
      intentData: { ...lock.intentData, tokenInAmount: lock.amount }
    })
  );
  if (compact === undefined || compact.lockId !== lock.lockId) {
    throw new LockedDepositError('lockMismatch', 'The new compact does not use the lock of this deposit.');
  }
  const chain = walletClient.chain ?? epochChain(lock.chainId);
  const compactAddress = await resolveCompactAddress(config, lock.chainId);
  const hash = await walletClient.writeContract({
    address: compactAddress,
    abi: COMPACT_ABI,
    functionName: 'register',
    args: [compact.claimHash, compact.typehash],
    account: sponsor,
    chain
  });
  await waitForEvmReceipt(hash, chain);
  return buildCreateAllocationRequest(config, compact.compactData, compact.witnessTypeString, lock.amount);
}

const REGISTRATION_LAG = /not (found on-chain|registered)/i;

/**
 * Submit the allocation. The allocator can read the chain a few blocks behind the registration, so retry while it
 * reports the claim as not registered.
 */
export async function submitWhenRegistered(
  sdk: Pick<EpochIntentSDK, 'submitAllocation'>,
  request: CompactRequest,
  { attempts = 6, delayMs = 2000 }: { attempts?: number; delayMs?: number } = {}
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const submitted = await sdk.submitAllocation(request);
      return submitted.nonce;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!REGISTRATION_LAG.test(message) || attempt >= attempts) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Register a locked deposit again with a fresh nonce, over the balance already in the lock, so the bridge continues
 * without a second deposit. Stop a forced withdrawal in progress first: the allocator refuses a lock while one is on.
 * Return the new intent nonce.
 */
export async function retryLockedDeposit(txId: string): Promise<string> {
  const { inputs, lock, sponsor } = await readLockedDeposit(txId);
  const allocatorUrl = inputs.epochAllocatorUrl ?? getEpochAllocatorUrl();
  const sdk = await connectSponsorSdk(lock, allocatorUrl);
  const status = await sdk.getForcedWithdrawalStatus(sponsor, lock.lockId);
  if (status.status !== 'Disabled') {
    await sdk.disableForcedWithdrawal(lock.lockId);
    await patchEpochLockedDeposit(txId, { withdrawEnabledAt: undefined, withdrawableAt: undefined });
  }
  const balance = await readCompactLockBalance(sdk, sponsor, lock.tokenAddress);
  if (balance === undefined || balance.lockId !== lock.lockId || balance.balance < BigInt(lock.amount)) {
    throw new LockedDepositError('depositMissing', 'The Compact no longer holds this deposit.');
  }
  const request = await registerCompactAgain(lock, sponsor, allocatorUrl);
  const nonce = await submitWhenRegistered(sdk, request);
  await markEpochLockedDepositReallocated(txId, nonce, allocatorUrl);
  await registerPendingBridgeIn(sponsor, nonce, {
    provider: 'epoch',
    sourceAmount: inputs.sourceAmount,
    sourceSymbol: inputs.sourceSymbol,
    intentNonce: nonce,
    evmTxHash: inputs.evmTxHash,
    bridgeReceiveTxId: txId,
    epochAllocatorUrl: allocatorUrl
  }).catch(err => console.warn('[epoch] registerPendingBridgeIn after retry failed', err));
  return nonce;
}
