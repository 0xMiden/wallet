import { useEffect, useState } from 'react';

import { liveQuery } from 'dexie';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import {
  ITransactionStatus,
  BridgedReceiveTransaction,
  type IOneClickPhase,
  type IOneClickTrackingData,
  type ITransaction
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import type { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { NoteTypeEnum } from 'lib/miden/types';

import {
  OneClickHttpError,
  assertOneClickQuoteBinding,
  fetchOneClickStatus,
  resolveOneClickDestinationReceipts,
  submitOneClickDeposit
} from './client';
import { assertOneClickFundingDeadline, effectiveOneClickFundingDeadline } from './deadline';
import {
  oneClickActualOutputAmount,
  oneClickDestinationFaucet,
  hasOneClickDeliveryArrived,
  hasOneClickDeliveryArrivedByAmount
} from './delivery';
import type { NearIntentsConfig, OneClickAsset, OneClickQuoteRequest, OneClickQuoteResponse } from './types';

/** A deposit row stays open for this time after its funding deadline before it can expire. */
export const NEAR_INTENTS_DEPOSIT_EXPIRY_GRACE_MS = 10 * 60_000;
/**
 * The additional time before a row expires when 1Click has no record of its address (HTTP 404). A 404 is weaker
 * evidence than a `PENDING_DEPOSIT` answer, so the row stays open for one day in case the answer is an error.
 */
export const NEAR_INTENTS_UNKNOWN_DEPOSIT_EXPIRY_MS = 24 * 60 * 60_000;
/**
 * How long after 1Click reports the delivery the wallet looks for the delivered note. After this time the row
 * closes as delivered, so a note that the wallet cannot match does not keep the row open.
 */
export const NEAR_INTENTS_ARRIVAL_CHECK_WINDOW_MS = 60 * 60_000;
export const NEAR_INTENTS_DEPOSIT_EXPIRED_ERROR = 'No deposit reached the 1Click address before the quote deadline.';

export interface OneClickTrackingInput {
  request: OneClickQuoteRequest;
  quote: OneClickQuoteResponse;
  config: NearIntentsConfig;
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
    depositAddress: input.quote.quote.depositAddress,
    depositMemo: input.quote.quote.depositMemo,
    updatedAt: Date.now()
  };
}

/**
 * Write the tracking-only row of a NEAR Intents deposit into Miden and return its id. The user pays the deposit
 * address from a wallet outside this one, so the row has no origin transaction hash. The row follows the deposit
 * through `GET /v0/status` alone.
 */
export async function persistNearIntentsDeposit(input: OneClickTrackingInput): Promise<string> {
  if (input.destinationAsset.blockchain !== 'miden' || input.originAsset.blockchain === 'miden') {
    throw new Error('A NEAR Intents deposit row requires a quote from another chain into Miden.');
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
  row.displayMessage = 'Receiving through NEAR Intents';
  await Repo.transactions.add(row);
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

function rowPhaseForOneClick(phase: IOneClickPhase): 'received' | 'failed' | 'delivering' {
  switch (phase) {
    case 'delivered':
      return 'received';
    case 'failed':
    case 'refunded':
    case 'expired':
      return 'failed';
    default:
      return 'delivering';
  }
}

export async function updateOneClickTrackingPhase(rowId: string, phase: IOneClickPhase): Promise<void> {
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
      return undefined;
    });
}

const TERMINAL_PHASES: ReadonlySet<IOneClickPhase> = new Set(['delivered', 'refunded', 'failed', 'expired']);

const isTerminal = (phase: IOneClickPhase): boolean => TERMINAL_PHASES.has(phase);

function fundingDeadlineMs(tracking: IOneClickTrackingData): number | undefined {
  if (tracking.fundingDeadline !== undefined) {
    const stored = Date.parse(tracking.fundingDeadline);
    return Number.isFinite(stored) ? stored : undefined;
  }
  try {
    return Date.parse(effectiveOneClickFundingDeadline(tracking.request.deadline, tracking.quote.quote.deadline));
  } catch {
    return undefined;
  }
}

/**
 * Tell if a deposit into Miden expired: 1Click still waits for the deposit (`PENDING_DEPOSIT`, or no status read
 * yet) and the funding deadline plus the grace time is in the past. A row with a known origin transaction, or with
 * any other provider status, never expires this way.
 */
export function isNearIntentsDepositExpired(tracking: IOneClickTrackingData, now = Date.now()): boolean {
  if (tracking.direction !== 'evm-to-miden' || tracking.originTransactionHash || isTerminal(tracking.phase))
    return false;
  if (tracking.providerStatus !== undefined && tracking.providerStatus !== 'PENDING_DEPOSIT') return false;
  const deadline = fundingDeadlineMs(tracking);
  return deadline !== undefined && now > deadline + NEAR_INTENTS_DEPOSIT_EXPIRY_GRACE_MS;
}

async function updateTracking(rowId: string, patch: Partial<IOneClickTrackingData>): Promise<void> {
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
        originTransactionHash: current.originTransactionHash ?? patch.originTransactionHash,
        providerSubmitted: current.providerSubmitted || patch.providerSubmitted,
        updatedAt: Math.max(current.updatedAt ?? 0, patch.updatedAt ?? 0)
      };
      transaction.extraInputs = {
        ...transaction.extraInputs,
        ...(transaction.type === 'bridged-receive' ? { phase: rowPhaseForOneClick(next.phase) } : {}),
        oneClick: next
      };
      return undefined;
    });
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
  // A NEAR Intents deposit row has no origin hash: the user pays from another wallet. So this step runs only for a
  // Miden send and for a row that an older build recorded with a hash.
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
    if (isNearIntentsDepositExpired({ ...updated, providerStatus: status.status })) {
      await updateTracking(transaction.id, {
        phase: 'expired',
        providerStatus: status.status,
        statusResponse: status,
        error: NEAR_INTENTS_DEPOSIT_EXPIRED_ERROR,
        updatedAt: Date.now()
      });
      return;
    }
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
      // The receipt service names the exact notes of the delivery. It is optional: when it gives no note ids, the
      // check below finds the delivery by its amount.
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
        }
      } catch (error) {
        console.warn('[one-click-tracking] destination receipt lookup failed', transaction.id, error);
      }
      try {
        const faucetId = oneClickDestinationFaucet(tracking);
        const amount = oneClickActualOutputAmount(tracking, status.swapDetails.amountOut);
        const successAgeMs = Date.now() - Date.parse(status.updatedAt);
        if (successAgeMs > NEAR_INTENTS_ARRIVAL_CHECK_WINDOW_MS) {
          // 1Click reported the delivery long ago and the wallet found no matching note (for example, a batch
          // claim took it). The success of the provider is final, so the row closes and the note reads stop.
          phase = 'delivered';
        } else if (faucetId && amount !== undefined) {
          const notes = await withWasmClientLock(
            async hold =>
              midenClientProxy.getConsumableNotes(tracking.accountId, step =>
                assertWasmHoldCurrent(hold, 'inside the 1Click delivery note read', step)
              ),
            { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'one-click-delivery' }
          );
          const consumed = await Repo.transactions.where('type').equals('consume').toArray();
          const noteIds = destinationNoteIds ?? [];
          const arrived =
            noteIds.length > 0
              ? hasOneClickDeliveryArrived({
                  targetAccountId: tracking.accountId,
                  faucetId,
                  amount,
                  noteIds,
                  consumableNotes: notes,
                  transactions: consumed
                })
              : hasOneClickDeliveryArrivedByAmount({
                  targetAccountId: tracking.accountId,
                  faucetId,
                  amount,
                  since: transaction.initiatedAt,
                  consumableNotes: notes,
                  transactions: consumed
                });
          if (arrived) phase = 'delivered';
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
    // 404 means 1Click has no record of the deposit address. The row expires one day after its deadline, so a row
    // that nobody paid does not stay open, and one incorrect 404 cannot close a paid deposit. Any other failure can
    // be a network fault, so the row stays open and the next round reads the status again.
    if (
      error instanceof OneClickHttpError &&
      error.status === 404 &&
      isNearIntentsDepositExpired(updated, Date.now() - NEAR_INTENTS_UNKNOWN_DEPOSIT_EXPIRY_MS)
    ) {
      await updateTracking(transaction.id, {
        phase: 'expired',
        error: NEAR_INTENTS_DEPOSIT_EXPIRED_ERROR,
        updatedAt: Date.now()
      });
      return;
    }
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

export function phaseForProviderStatus(status: IOneClickTrackingData['providerStatus']): IOneClickPhase {
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
