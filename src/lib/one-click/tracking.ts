import { useEffect, useState } from 'react';

import { liveQuery } from 'dexie';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import {
  ITransactionStatus,
  BridgedReceiveTransaction,
  type IOneClickTrackingData,
  type ITransaction
} from 'lib/miden/db/types';
import { checkpointProviderReceipt } from 'lib/miden/recovery/receipt-writer';
import * as Repo from 'lib/miden/repo';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import type { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { NoteTypeEnum } from 'lib/miden/types';

import {
  ONE_CLICK_EVM_CHAIN_IDS,
  assertOneClickQuoteBinding,
  fetchOneClickStatus,
  resolveOneClickDestinationReceipts,
  submitOneClickDeposit
} from './client';
import { assertOneClickFundingDeadline } from './deadline';
import { oneClickActualOutputAmount, oneClickDestinationFaucet, hasOneClickDeliveryArrived } from './delivery';
import type { OneClickAsset, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

export interface OneClickTrackingInput {
  request: OneClickQuoteRequest;
  quote: OneClickQuoteResponse;
  config: OneClickConfig;
  network: string;
  accountId: string;
  accountAddress: string;
  originAsset: OneClickAsset;
  destinationAsset: OneClickAsset;
  faucetId: string;
}

export interface OneClickMidenDepositDetails extends OneClickTrackingInput {
  accountId: string;
  accountAddress: string;
}

function oneClickOf(transaction: ITransaction): IOneClickTrackingData | undefined {
  const inputs: { oneClick?: IOneClickTrackingData } | undefined = transaction.extraInputs;
  const tracking = inputs?.oneClick;
  if (!tracking || !tracking.quote || !tracking.config || !tracking.accountId || !tracking.depositAddress)
    return undefined;
  return tracking;
}

export const isOneClickTransaction = (transaction: ITransaction): boolean => oneClickOf(transaction) !== undefined;

export async function getOneClickTransactions(): Promise<ITransaction[]> {
  const [sends, receives] = await Promise.all([
    Repo.transactions.where('type').equals('send').toArray(),
    Repo.transactions.where('type').equals('bridged-receive').toArray()
  ]);
  return [...sends, ...receives]
    .filter(isOneClickTransaction)
    .sort((left, right) => right.initiatedAt - left.initiatedAt);
}

export function useOneClickTransactions(): ITransaction[] {
  const [rows, setRows] = useState<ITransaction[]>([]);
  useEffect(() => {
    const subscription = liveQuery(getOneClickTransactions).subscribe({
      next: setRows,
      error: error => console.warn('[one-click-tracking] transaction query failed', error)
    });
    return () => subscription.unsubscribe();
  }, []);
  return rows;
}

function validateTrackingInput(input: OneClickTrackingInput): string {
  assertOneClickQuoteBinding(input.request, input.quote, false, input.config);
  const fundingDeadline = assertOneClickFundingDeadline(input.request.deadline, input.quote.quote.deadline);
  if (!input.quote.quote.depositAddress)
    throw new Error('The 1Click quote has no deposit address. Request a new quote.');
  if (
    input.request.originAsset.assetId !== input.originAsset.assetId ||
    input.request.destinationAsset.assetId !== input.destinationAsset.assetId
  ) {
    throw new Error('The 1Click quote asset metadata does not match the signed route.');
  }
  const walletBoundAddress =
    input.destinationAsset.blockchain === 'miden' ? input.request.recipient : input.request.refundTo;
  if (!sameWalletAccountId(walletBoundAddress, input.accountAddress)) {
    throw new Error('The 1Click quote is not bound to the selected Miden account.');
  }
  if (!input.network || !input.accountId || !input.accountAddress || !input.faucetId) {
    throw new Error('The 1Click route is missing wallet account details.');
  }
  return fundingDeadline;
}

function trackingData(
  input: OneClickTrackingInput,
  direction: IOneClickTrackingData['direction']
): IOneClickTrackingData {
  const fundingDeadline = validateTrackingInput(input);
  const midenAsset = direction === 'evm-to-miden' ? input.destinationAsset : input.originAsset;
  if (midenAsset.blockchain !== 'miden') throw new Error('The 1Click quote does not contain a Miden asset.');
  const mapped = input.config.midenAssets.find(asset => asset.assetId === midenAsset.assetId);
  if (!mapped || mapped.faucetId !== input.faucetId)
    throw new Error('The 1Click Miden asset mapping does not match this wallet token.');
  return {
    direction,
    request: input.request,
    quote: input.quote,
    fundingDeadline,
    config: input.config,
    network: input.network,
    accountId: input.accountId,
    accountAddress: input.accountAddress,
    originAsset: input.originAsset,
    destinationAsset: input.destinationAsset,
    faucetId: input.faucetId,
    amount: direction === 'evm-to-miden' ? input.quote.quote.amountOut : input.quote.quote.amountIn,
    phase: 'depositing',
    ...(direction === 'evm-to-miden' && ONE_CLICK_EVM_CHAIN_IDS[input.originAsset.blockchain] !== undefined
      ? { evmSubmission: 'not-started' as const }
      : {}),
    depositAddress: input.quote.quote.depositAddress,
    depositMemo: input.quote.quote.depositMemo,
    updatedAt: Date.now()
  };
}

function samePersistedDepositReference(left: IOneClickTrackingData, right: IOneClickTrackingData): boolean {
  const leftChainId = left.originAsset.chainId ?? left.request.originAsset.chainId ?? '';
  const rightChainId = right.originAsset.chainId ?? right.request.originAsset.chainId ?? '';
  return (
    left.originAsset.blockchain === right.originAsset.blockchain &&
    leftChainId === rightChainId &&
    left.depositAddress?.trim().toLowerCase() === right.depositAddress?.trim().toLowerCase() &&
    (left.depositMemo ?? '') === (right.depositMemo ?? '')
  );
}

function blocksEvmDepositRetry(tracking: IOneClickTrackingData): boolean {
  if (tracking.originTransactionHash || tracking.evmSubmission === 'known') return true;
  if (tracking.evmSubmission === 'not-started') return false;
  return true;
}

export class OneClickEvmDepositAlreadyAttemptedError extends Error {
  constructor() {
    super('This EVM deposit reference already has a pending or ambiguous funding attempt');
    this.name = 'OneClickEvmDepositAlreadyAttemptedError';
  }
}

export async function claimOneClickEvmDepositAttempt(rowId: string): Promise<void> {
  let claimed: ITransaction | undefined;
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    const row = await Repo.transactions.get(rowId);
    const tracking = row ? oneClickOf(row) : undefined;
    if (
      !row ||
      !tracking ||
      tracking.direction !== 'evm-to-miden' ||
      ONE_CLICK_EVM_CHAIN_IDS[tracking.originAsset.blockchain] === undefined
    ) {
      throw new Error('The EVM deposit tracking row could not be claimed');
    }
    if (tracking.evmSubmission !== 'not-started' || tracking.originTransactionHash) {
      throw new OneClickEvmDepositAlreadyAttemptedError();
    }
    const existing = await Repo.transactions.where('type').equals('bridged-receive').toArray();
    const conflict = existing.some(candidate => {
      if (candidate.id === rowId) return false;
      const persisted = oneClickOf(candidate);
      if (!persisted || persisted.direction !== 'evm-to-miden') return false;
      if (!samePersistedDepositReference(tracking, persisted)) return false;
      return blocksEvmDepositRetry(persisted);
    });
    if (conflict) throw new OneClickEvmDepositAlreadyAttemptedError();
    row.extraInputs = {
      ...row.extraInputs,
      phase: 'delivering',
      oneClick: { ...tracking, evmSubmission: 'attempted', updatedAt: Date.now() }
    };
    await Repo.transactions.update(rowId, { extraInputs: row.extraInputs });
    claimed = row;
  });
  if (!claimed) throw new Error('The EVM deposit tracking row could not be claimed');
  await checkpointProviderReceipt(claimed);
}

export async function retireOneClickEvmPreflightFailure(rowId: string, ownsAttemptClaim = false): Promise<void> {
  let retained: ITransaction | undefined;
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    const transaction = await Repo.transactions.get(rowId);
    const tracking = transaction ? oneClickOf(transaction) : undefined;
    if (
      !transaction ||
      !tracking ||
      tracking.direction !== 'evm-to-miden' ||
      tracking.originTransactionHash ||
      tracking.evmSubmission === 'known' ||
      (tracking.evmSubmission === 'attempted' && !ownsAttemptClaim) ||
      (tracking.evmSubmission !== 'attempted' && tracking.evmSubmission !== 'not-started')
    ) {
      return;
    }
    const updated = {
      ...transaction,
      extraInputs: {
        ...transaction.extraInputs,
        phase: 'failed',
        oneClick: { ...tracking, evmSubmission: 'not-started', phase: 'failed', updatedAt: Date.now() }
      }
    };
    await Repo.transactions.put(updated);
    retained = updated;
  });
  if (retained) await checkpointProviderReceipt(retained);
}

export async function persistOneClickTrackingRow(input: OneClickTrackingInput): Promise<string> {
  if (input.destinationAsset.blockchain !== 'miden' || input.originAsset.blockchain === 'miden') {
    throw new Error('A tracking-only 1Click row requires an EVM-to-Miden quote.');
  }
  const tracking = trackingData(input, 'evm-to-miden');
  const row = new BridgedReceiveTransaction(
    input.accountId,
    BigInt(tracking.amount),
    input.faucetId,
    'near-intents',
    input.request.refundTo,
    input.quote.quote.amountInFormatted,
    input.originAsset.symbol,
    input.quote.quote.amountOutFormatted,
    input.destinationAsset.symbol
  );
  row.extraInputs.oneClick = tracking;
  row.extraInputs.phase = 'submitting';
  row.displayMessage = 'Swapping through 1Click';
  await Repo.transactions.add(row);
  await checkpointProviderReceipt(row);
  return row.id;
}

export async function initiateOneClickMidenDeposit(
  input: OneClickMidenDepositDetails,
  authorization?: SpendingLimitAuthorization
): Promise<string> {
  if (input.originAsset.blockchain !== 'miden' || input.destinationAsset.blockchain === 'miden') {
    throw new Error('A 1Click Miden deposit requires a Miden-to-EVM quote.');
  }
  const tracking = trackingData(input, 'miden-to-evm');
  const { initiateSendTransaction } = await import('lib/miden/activity');
  return initiateSendTransaction(
    input.accountId,
    tracking.depositAddress ?? '',
    input.faucetId,
    NoteTypeEnum.Public,
    BigInt(tracking.amount),
    undefined,
    undefined,
    authorization,
    undefined,
    tracking
  );
}

export async function recordOneClickOriginTransactionHash(rowId: string, transactionHash: string): Promise<void> {
  let retained: ITransaction | undefined;
  await Repo.transactions
    .where('id')
    .equals(rowId)
    .modify(transaction => {
      const tracking = oneClickOf(transaction);
      if (!tracking) return false;
      if (tracking.direction !== 'evm-to-miden') return false;
      if (
        (tracking.originTransactionHash && tracking.originTransactionHash !== transactionHash) ||
        (transaction.extraInputs.evmTxHash && transaction.extraInputs.evmTxHash !== transactionHash)
      )
        return false;
      transaction.extraInputs = {
        ...transaction.extraInputs,
        evmTxHash: transactionHash,
        oneClick: {
          ...tracking,
          originTransactionHash: transactionHash,
          phase: tracking.originTransactionHash || isTerminal(tracking.phase) ? tracking.phase : 'known-deposit-tx',
          evmSubmission: 'known',
          updatedAt: Date.now()
        }
      };
      retained = transaction;
      return undefined;
    });
  if (!retained) throw new Error('The EVM deposit tracking row is unavailable');
  await checkpointProviderReceipt(retained);
}

function rowPhaseForOneClick(phase: IOneClickTrackingData['phase']): 'received' | 'failed' | 'delivering' {
  if (phase === 'delivered') return 'received';
  if (phase === 'failed' || phase === 'refunded') return 'failed';
  return 'delivering';
}

export async function updateOneClickTrackingPhase(rowId: string, phase: IOneClickTrackingData['phase']): Promise<void> {
  let retained: ITransaction | undefined;
  await Repo.transactions
    .where('id')
    .equals(rowId)
    .modify(transaction => {
      const tracking = oneClickOf(transaction);
      if (!tracking) return false;
      transaction.extraInputs = {
        ...transaction.extraInputs,
        ...(transaction.type === 'bridged-receive' ? { phase: rowPhaseForOneClick(phase) } : {}),
        oneClick: { ...tracking, phase, updatedAt: Date.now() }
      };
      retained = transaction;
      return undefined;
    });
  if (retained) await checkpointProviderReceipt(retained);
}

const isTerminal = (phase: IOneClickTrackingData['phase']): boolean =>
  phase === 'delivered' || phase === 'refunded' || phase === 'failed';

async function updateTracking(rowId: string, patch: Partial<IOneClickTrackingData>): Promise<void> {
  let retained: ITransaction | undefined;
  await Repo.transactions
    .where('id')
    .equals(rowId)
    .modify(transaction => {
      const current = oneClickOf(transaction);
      if (!current) return false;
      if (isTerminal(current.phase)) return false;
      const next: IOneClickTrackingData = {
        ...current,
        ...patch,
        evmSubmission: current.evmSubmission ?? patch.evmSubmission,
        originTransactionHash: current.originTransactionHash ?? patch.originTransactionHash,
        providerSubmitted: current.providerSubmitted || patch.providerSubmitted,
        updatedAt: Math.max(current.updatedAt ?? 0, patch.updatedAt ?? 0)
      };
      transaction.extraInputs = {
        ...transaction.extraInputs,
        ...(transaction.type === 'bridged-receive' ? { phase: rowPhaseForOneClick(next.phase) } : {}),
        oneClick: next
      };
      retained = { ...transaction };
      return undefined;
    });
  if (retained) await checkpointProviderReceipt(retained);
}

async function reconcileRow(transaction: ITransaction): Promise<void> {
  const tracking = oneClickOf(transaction);
  if (!tracking || transaction.restoredFromBackup || isTerminal(tracking.phase)) return;
  if (
    transaction.type === 'send' &&
    (transaction.status !== ITransactionStatus.Completed || !transaction.transactionId)
  )
    return;

  const depositAddress = tracking.depositAddress;
  if (!depositAddress) return;
  let updated = tracking;
  const originTransactionHash =
    tracking.direction === 'miden-to-evm' ? transaction.transactionId : tracking.originTransactionHash;
  if (originTransactionHash && !tracking.providerSubmitted) {
    try {
      const submitted = await submitOneClickDeposit(
        tracking.config,
        depositAddress,
        originTransactionHash,
        tracking.depositMemo,
        tracking.quote
      );
      const submittedPhase =
        submitted.status === 'SUCCESS' && tracking.direction === 'miden-to-evm'
          ? 'delivered'
          : phaseForProviderStatus(submitted.status);
      updated = {
        ...updated,
        providerSubmitted: true,
        providerStatus: submitted.status,
        statusResponse: submitted,
        phase: submittedPhase,
        updatedAt: Date.now()
      };
      await updateTracking(transaction.id, {
        providerSubmitted: true,
        providerStatus: submitted.status,
        statusResponse: submitted,
        phase: submittedPhase,
        updatedAt: updated.updatedAt
      });
      if (submittedPhase === 'delivered') return;
    } catch (error) {
      console.warn('[one-click-tracking] deposit submission failed', transaction.id, error);
    }
  }

  try {
    const status = await fetchOneClickStatus(tracking.config, depositAddress, tracking.depositMemo, tracking.quote);
    let phase = phaseForProviderStatus(status.status);
    const actualOutputAmount =
      tracking.direction === 'evm-to-miden' && status.status === 'SUCCESS'
        ? oneClickActualOutputAmount(tracking, status.swapDetails.amountOut)
        : undefined;
    let destinationNoteIds: string[] | undefined;
    if (status.status === 'SUCCESS' && tracking.direction === 'evm-to-miden') {
      phase = 'arriving';
      updated = {
        ...updated,
        phase,
        providerStatus: status.status,
        statusResponse: status,
        updatedAt: Date.now()
      };
      await updateTracking(transaction.id, {
        phase,
        providerStatus: status.status,
        statusResponse: status,
        updatedAt: updated.updatedAt
      });
      try {
        const hashes = status.swapDetails.destinationChainTxHashes.map(item => item.hash);
        if (hashes.length > 0) {
          const receipts = await resolveOneClickDestinationReceipts(tracking.config, hashes);
          const expectedHashes = new Set(hashes.map(hash => hash.toLowerCase()));
          destinationNoteIds = [
            ...new Set(
              receipts
                .filter(receipt => expectedHashes.has(receipt.transactionHash.toLowerCase()))
                .flatMap(receipt => receipt.noteIds)
            )
          ];
          const faucetId = oneClickDestinationFaucet(tracking);
          const amount = oneClickActualOutputAmount(tracking, status.swapDetails.amountOut);
          if (faucetId && destinationNoteIds.length > 0 && amount !== undefined) {
            const notes = await withWasmClientLock(
              async hold =>
                midenClientProxy.getConsumableNotes(tracking.accountId, step =>
                  assertWasmHoldCurrent(hold, 'inside the 1Click delivery note read', step)
                ),
              { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'one-click-delivery' }
            );
            const consumed = await Repo.transactions.where('type').equals('consume').toArray();
            if (
              hasOneClickDeliveryArrived({
                targetAccountId: tracking.accountId,
                faucetId,
                amount,
                noteIds: destinationNoteIds,
                consumableNotes: notes,
                transactions: consumed
              })
            ) {
              phase = 'delivered';
            }
          }
        }
      } catch (error) {
        console.warn('[one-click-tracking] destination delivery check failed', transaction.id, error);
      }
    } else if (status.status === 'SUCCESS' && tracking.direction === 'miden-to-evm') {
      phase = 'delivered';
    }
    updated = {
      ...updated,
      ...(actualOutputAmount !== undefined ? { amount: actualOutputAmount.toString() } : {}),
      phase,
      providerStatus: status.status,
      statusResponse: status,
      ...(destinationNoteIds !== undefined ? { destinationNoteIds } : {}),
      ...(status.status === 'FAILED' ? { error: status.swapDetails.refundReason ?? 'The 1Click swap failed.' } : {}),
      updatedAt: Date.now()
    };
    await updateTracking(transaction.id, {
      ...(actualOutputAmount !== undefined ? { amount: actualOutputAmount.toString() } : {}),
      phase,
      providerStatus: status.status,
      statusResponse: status,
      ...(destinationNoteIds !== undefined ? { destinationNoteIds } : {}),
      error: status.status === 'FAILED' ? (status.swapDetails.refundReason ?? 'The 1Click swap failed.') : undefined,
      updatedAt: updated.updatedAt
    });
  } catch (error) {
    console.warn('[one-click-tracking] status reconciliation failed', transaction.id, error);
  }
}

export async function reconcileOneClickSwaps(): Promise<void> {
  const rows = await getOneClickTransactions();
  for (const row of rows) {
    try {
      await reconcileRow(row);
    } catch (error) {
      console.warn('[one-click-tracking] row reconciliation failed', row.id, error);
    }
  }
}

export function phaseForProviderStatus(
  status: IOneClickTrackingData['providerStatus']
): IOneClickTrackingData['phase'] {
  switch (status) {
    case 'KNOWN_DEPOSIT_TX':
      return 'known-deposit-tx';
    case 'PENDING_DEPOSIT':
      return 'pending-deposit';
    case 'INCOMPLETE_DEPOSIT':
      return 'incomplete-deposit';
    case 'PROCESSING':
      return 'processing';
    case 'SUCCESS':
      return 'arriving';
    case 'REFUNDED':
      return 'refunded';
    case 'FAILED':
      return 'failed';
    default:
      return 'processing';
  }
}
