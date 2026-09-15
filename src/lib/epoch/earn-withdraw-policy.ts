import { getMidenMetadata, isEVMToMidenIntent, validateWitnessTypeString } from '@epoch-protocol/epoch-intents-sdk';
import type { CompactRequest, PreparedAllocation, PreparedExecution } from '@epoch-protocol/epoch-intents-sdk';
import { AccountId, Address } from '@miden-sdk/miden-sdk';

import { ITransactionStatus } from 'lib/miden/db/types';
import type { IEarnWithdrawExtraInputs, IEarnWithdrawPreparedExecution, ITransaction } from 'lib/miden/db/types';

import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { isEvmAddress } from './evm-address';
import { effectiveWithdrawAttemptId } from './intent-key';

export interface EarnWithdrawExecutionIdentity {
  owner: string;
  attemptId: string;
  sourceChainId: number;
  destinationChainId: number;
  recipientAccountId: string;
  destinationFaucetId: string;
}

export interface ValidatedEarnWithdrawExecution {
  readonly preparedExecution: IEarnWithdrawPreparedExecution;
  readonly allocationRequests: readonly CompactRequest[];
}

export type EarnWithdrawalRetryKind = 'source' | 'allocation';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function uint(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function canonicalMidenId(value: unknown): string | undefined {
  if (!text(value)) return undefined;
  try {
    const raw = value.trim();
    if (raw.startsWith('0x') || raw.startsWith('0X')) return AccountId.fromHex(raw).toString();
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) return AccountId.fromHex(`0x${raw}`).toString();
    if (raw.includes('_')) return Address.fromBech32(raw).accountId().toString();
    return AccountId.fromBech32(raw).toString();
  } catch {
    return undefined;
  }
}

function validRequest(value: unknown): value is CompactRequest {
  if (
    !record(value) ||
    !uint(value.chainId) ||
    value.isRegisteredOnchain !== true ||
    value.sponsorSignature !== '0x' ||
    !text(value.witnessTypeString) ||
    !record(value.compact)
  )
    return false;
  const compact = value.compact;
  const mandate = compact.mandate;
  if (
    !isEvmAddress(compact.arbiter) ||
    !isEvmAddress(compact.sponsor) ||
    !['nonce', 'expires', 'id', 'amount'].every(key => uint(compact[key])) ||
    !text(compact.lockTag) ||
    !text(compact.token) ||
    !record(mandate) ||
    !['tokenIn', 'tokenOut', 'taskType', 'recipient'].every(key => text(mandate[key])) ||
    !['tokenInAmount', 'minTokenOut', 'destinationChainId'].every(key => uint(mandate[key]))
  )
    return false;
  if (!validateWitnessTypeString(value.witnessTypeString, mandate).valid) return false;
  const routing = value.routingAndLiquidityOptions;
  return (
    routing === undefined ||
    (record(routing) &&
      (routing.preset === 'any' ||
        routing.preset === 'filler-single-transaction' ||
        routing.preset === 'external-multi-transactions' ||
        (routing.preset === 'custom' && Array.isArray(routing.solvers) && routing.solvers.every(isEvmAddress))))
  );
}

function decodeAllocations(
  value: unknown,
  expected: EarnWithdrawExecutionIdentity
): { allocations: PreparedAllocation[]; requests: CompactRequest[]; deliveryIndex: number } | undefined {
  if (
    !record(value) ||
    value.chainId !== expected.sourceChainId ||
    !Array.isArray(value.allocations) ||
    value.allocations.length === 0 ||
    !isEvmAddress(expected.owner)
  )
    return undefined;
  const recipient = canonicalMidenId(expected.recipientAccountId);
  const faucet = canonicalMidenId(expected.destinationFaucetId);
  if (!recipient || !faucet) return undefined;
  const allocations: PreparedAllocation[] = [];
  const requests: CompactRequest[] = [];
  let deliveryIndex = -1;
  for (const item of value.allocations) {
    if (
      !record(item) ||
      !isEvmAddress(item.sponsor) ||
      !uint(item.nonce) ||
      !uint(item.expires) ||
      !text(item.requestJson)
    )
      return undefined;
    let request: unknown;
    try {
      request = JSON.parse(item.requestJson);
    } catch {
      return undefined;
    }
    if (
      !validRequest(request) ||
      request.chainId !== String(expected.sourceChainId) ||
      request.compact.sponsor.toLowerCase() !== expected.owner.toLowerCase() ||
      request.compact.sponsor !== item.sponsor ||
      request.compact.nonce !== item.nonce ||
      request.compact.expires !== item.expires
    )
      return undefined;
    if (isEVMToMidenIntent(request.compact.mandate)) {
      const metadata = getMidenMetadata(request.compact.mandate, request.witnessTypeString);
      if (
        !metadata ||
        Number(request.compact.mandate?.destinationChainId) !== expected.destinationChainId ||
        canonicalMidenId(metadata.midenRecipientAccount) !== recipient ||
        canonicalMidenId(metadata.midenFaucetId) !== faucet ||
        deliveryIndex !== -1
      )
        return undefined;
      deliveryIndex = allocations.length;
    }
    allocations.push({
      sponsor: item.sponsor,
      nonce: item.nonce,
      expires: item.expires,
      requestJson: item.requestJson
    });
    requests.push(request);
  }
  return deliveryIndex < 0 ? undefined : { allocations, requests, deliveryIndex };
}

export function earnWithdrawExecutionIdentity(row: ITransaction): EarnWithdrawExecutionIdentity | undefined {
  const inputs: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
  if (row.type !== 'earn-withdraw' || !inputs || !isEvmAddress(inputs.evmOwner)) return undefined;
  if (typeof inputs.marketUid !== 'string') return undefined;
  const sourceChainId = Number(inputs.marketUid.split(':')[1]);
  const recipientAccountId = canonicalMidenId(row.accountId);
  const destinationFaucetId = canonicalMidenId(inputs.destinationFaucetId);
  if (!Number.isSafeInteger(sourceChainId) || sourceChainId <= 0 || !recipientAccountId || !destinationFaucetId)
    return undefined;
  return {
    owner: inputs.evmOwner,
    attemptId: effectiveWithdrawAttemptId(row.id, inputs.submissionAttemptId),
    sourceChainId,
    destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
    recipientAccountId,
    destinationFaucetId
  };
}

export function selectEarnWithdrawPreparedExecution(
  prepared: PreparedExecution,
  expected: EarnWithdrawExecutionIdentity
): IEarnWithdrawPreparedExecution | undefined {
  const decoded = decodeAllocations(prepared, expected);
  if (!decoded) return undefined;
  const selected = decoded.allocations[decoded.deliveryIndex];
  const recipientAccountId = canonicalMidenId(expected.recipientAccountId);
  const destinationFaucetId = canonicalMidenId(expected.destinationFaucetId);
  if (!selected || !recipientAccountId || !destinationFaucetId) return undefined;
  return {
    chainId: prepared.chainId,
    allocations: decoded.allocations,
    attemptId: expected.attemptId,
    delivery: {
      allocationIndex: decoded.deliveryIndex,
      owner: selected.sponsor,
      nonce: selected.nonce,
      destinationChainId: expected.destinationChainId,
      recipientAccountId,
      destinationFaucetId
    }
  };
}

export function validateEarnWithdrawPreparedExecution(
  value: unknown,
  expected: EarnWithdrawExecutionIdentity
): ValidatedEarnWithdrawExecution | undefined {
  if (!record(value) || value.attemptId !== expected.attemptId || !record(value.delivery)) return undefined;
  const decoded = decodeAllocations(value, expected);
  if (!decoded) return undefined;
  const prepared = selectEarnWithdrawPreparedExecution(
    { chainId: expected.sourceChainId, allocations: decoded.allocations },
    expected
  );
  const delivery = value.delivery;
  if (!prepared || Object.entries(prepared.delivery).some(([key, entry]) => delivery[key] !== entry)) return undefined;
  return { preparedExecution: prepared, allocationRequests: decoded.requests };
}

export function earnWithdrawalRetryKind(row: ITransaction | undefined | null): EarnWithdrawalRetryKind | undefined {
  if (
    !row ||
    row.type !== 'earn-withdraw' ||
    row.restoredFromBackup ||
    row.status !== ITransactionStatus.Completed ||
    row.extraInputs?.phase !== 'failed'
  )
    return undefined;
  const identity = earnWithdrawExecutionIdentity(row);
  if (!identity) return undefined;
  const inputs: IEarnWithdrawExtraInputs = row.extraInputs;
  if (
    inputs.submissionState === 'preparing' &&
    inputs.withdrawIntentNonce === undefined &&
    inputs.preparedExecution === undefined &&
    inputs.evmTxHash === undefined &&
    inputs.midenNoteId === undefined &&
    inputs.outputAmount === undefined &&
    inputs.outputSymbol === undefined &&
    typeof inputs.sourceAmount === 'string' &&
    /^\d+(?:\.\d+)?$/.test(inputs.sourceAmount) &&
    Number(inputs.sourceAmount) > 0
  )
    return 'source';
  if (inputs.submissionState !== 'prepared' && inputs.submissionState !== 'accepted') return undefined;
  const execution = validateEarnWithdrawPreparedExecution(inputs.preparedExecution, identity);
  return execution && execution.preparedExecution.delivery.nonce === inputs.withdrawIntentNonce
    ? 'allocation'
    : undefined;
}

export function hasEarnWithdrawRecoveryWork(row: ITransaction): boolean {
  if (row.type !== 'earn-withdraw') return false;
  const inputs: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
  if (inputs?.phase === 'redeeming' || inputs?.phase === 'delivering') return true;
  if (
    !inputs ||
    row.restoredFromBackup ||
    row.status !== ITransactionStatus.Completed ||
    inputs.submissionState !== 'prepared'
  )
    return false;
  const identity = earnWithdrawExecutionIdentity(row);
  const validated = identity && validateEarnWithdrawPreparedExecution(inputs.preparedExecution, identity);
  return Boolean(validated && validated.preparedExecution.delivery.nonce === inputs.withdrawIntentNonce);
}
