/**
 * Poll every open fiat buy row and move it along with its backend order.
 *
 * The backend owns the order until the relay transaction is mined: it watches Transak and relays the signed bridge
 * batch. Its `deposited` state is terminal. The wallet does four things here:
 * - It copies the backend state onto the local row as a buy phase, for the progress screen.
 * - It signs the bridge batch when the backend asks for a signature (`awaiting_signature`). The vault signs without a
 *   prompt, so this happens only while the wallet is unlocked.
 * - It polls the Agglayer indexer for the deposit of the relay transaction while the row is `bridging`. The backend
 *   is not asked again for that row.
 * - It queues the consume of the bridged note when the indexer reports the deposit as claimed on Miden.
 */
import { AGGLAYER_TRNSK_FAUCET_ID } from 'lib/agglayer/constant';
import {
  AgglayerDeposit,
  fetchDeposits,
  isAgglayerDepositClaimed,
  isAgglayerDepositReady,
  sameTxHash
} from 'lib/agglayer/status';
import * as Repo from 'lib/miden/repo';
import { BuyApiError, BuyOrder, getBuyOrder } from 'lib/onramp/buy-api';
import { midenAccountHexToEvmAddress, midenAccountIdToHex } from 'lib/onramp/buy-batch';
import { BuySignRefusedError, signBuyOrder } from 'lib/onramp/buy-signer';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { compareAccountIds } from './utils';
import { IBridgeInInfo, IBuyExtraInputs, IBuyPhase, ITransaction, ITransactionStatus } from '../db/types';
import { updateBuyPhase } from '../transaction/complete';
import { initiateConsumeTransaction } from '../transaction/initiate';
import { ConsumableNote } from '../types';

/** A buy row that is not terminal after this time is failed. */
export const BUY_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const BUY_TIMED_OUT = 'The buy did not finish within 7 days.';
const RESTORED_BUY_UNVERIFIABLE = 'Restored from a backup — the buy could not be verified.';

export interface BuyReconcileContext {
  /** Account whose live claimable notes are in `claimableNotes`. */
  claimableAccountId?: string;
  /** Latest claimable notes of `claimableAccountId`. `undefined` when no read has landed yet. */
  claimableNotes?: readonly ConsumableNote[];
  /** Start the transaction queue after a consume is queued. */
  kickTransactions?: () => void;
}

/**
 * Signing values already signed in this realm. The backend returns the same values on each poll until it has the
 * signature, so without this guard the wallet signs the same batch every tick. New values (a new nonce, a lower
 * amount, a new salt) make a new key and are signed once.
 */
const signedBatches = new Set<string>();

/**
 * Minimum time between two indexer reads for one row. The watcher ticks each 8 s, which is too often for the indexer.
 */
export const BUY_INDEXER_POLL_INTERVAL_MS = 30_000;

/** Time of the last indexer read for each buy row id. In memory only: a new realm reads again at once. */
const indexerPolledAt = new Map<string, number>();

/** Buy row ids whose deposit the indexer already shows, so that the log line occurs one time for each row. */
const seenDeposits = new Set<string>();

// Unclaimed deposits report `claim_tx_hash` as absent, empty, or all zeroes.
const ZERO_TX_HASH = /^(0x)?0*$/i;

/** Test-only: forget the signed batches and the indexer poll state. */
export function __resetBuyOrderMemoryForTests(): void {
  signedBatches.clear();
  indexerPolledAt.clear();
  seenDeposits.clear();
}

function isOpenPhase(phase: IBuyPhase | undefined): boolean {
  return phase !== undefined && phase !== 'completed' && phase !== 'failed';
}

function signingKey(order: BuyOrder): string | undefined {
  const prepare = order.prepare;
  if (!prepare) return undefined;
  return [
    order.id,
    prepare.batchNonce,
    prepare.tokenAmount,
    prepare.salt.toLowerCase(),
    prepare.needsAuthorization ? `auth:${prepare.authorizationNonce}` : 'delegated'
  ].join('|');
}

function isBaseUnits(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

/** Token fields of the order that the row keeps, when the backend knows them. */
function tokenPatch(order: BuyOrder): Partial<IBuyExtraInputs> {
  return {
    ...(order.tokenAmount !== null ? { tokenAmount: order.tokenAmount, tokenDecimals: order.tokenDecimals } : {}),
    ...(order.relayTxHash !== null ? { relayTxHash: order.relayTxHash } : {})
  };
}

async function signIfAsked(row: ITransaction, inputs: IBuyExtraInputs, order: BuyOrder): Promise<void> {
  const key = signingKey(order);
  if (!key || signedBatches.has(key)) return;

  const store = useWalletStore.getState();
  if (store.status !== WalletStatus.Ready) return;
  const account = store.accounts.find(candidate => compareAccountIds(candidate.publicKey, row.accountId));
  if (!account?.evmAddress) {
    console.warn('[buy]', 'account has no EVM address; cannot sign', { id: row.id });
    return;
  }

  signedBatches.add(key);
  try {
    const state = await signBuyOrder({
      account: {
        publicKey: account.publicKey,
        evmAddress: account.evmAddress,
        midenAccountHex: midenAccountIdToHex(account.publicKey)
      },
      fiatAmount: inputs.fiatAmount,
      order
    });
    console.info('[buy]', 'signed bridge batch', { id: row.id, orderId: order.id, state });
  } catch (error) {
    switch (true) {
      case error instanceof BuySignRefusedError:
        // Keep the key: the same values are refused again. New values make a new key.
        console.warn('[buy]', 'refused to sign', { id: row.id, reason: error.reason });
        break;
      case error instanceof BuyApiError && error.status !== undefined:
        // The backend answered. Its next poll gives fresh values if these were stale.
        console.warn('[buy]', 'signature rejected', { id: row.id, status: error.status, message: error.message });
        break;
      default:
        // No answer, or the vault failed: try the same values again on the next tick.
        signedBatches.delete(key);
        console.warn('[buy]', 'signing failed', { id: row.id, error });
        break;
    }
  }
}

/** Link a consume row to its buy row, so its completion completes the buy. */
async function linkConsumeRow(consumeId: string, row: ITransaction, inputs: IBuyExtraInputs, noteId: string) {
  const bridgeIn: IBridgeInInfo = {
    provider: 'agglayer',
    sourceAmount: inputs.fiatAmount,
    sourceSymbol: inputs.tokenSymbol,
    evmTxHash: inputs.relayTxHash,
    midenNoteId: noteId,
    buyTxId: row.id
  };
  await Repo.transactions.where({ id: consumeId }).modify(tx => {
    if (tx.type !== 'consume') return;
    tx.extraInputs = { ...(tx.extraInputs ?? {}), bridgeIn };
  });
}

function matchesBoughtNote(note: ConsumableNote, amount: bigint): boolean {
  if (note.fromCache || note.swapOrder || !isBaseUnits(note.amount)) return false;
  if (AGGLAYER_TRNSK_FAUCET_ID !== undefined && !compareAccountIds(AGGLAYER_TRNSK_FAUCET_ID, note.faucetId)) {
    return false;
  }
  return BigInt(note.amount) === amount;
}

/**
 * Move a `consuming` row to its consume. When the row already has a consume, follow that row. Else find the bridged
 * note in the live claimable notes and queue a consume for it.
 */
async function consumeBoughtNote(
  row: ITransaction,
  inputs: IBuyExtraInputs,
  takenNoteIds: ReadonlySet<string>,
  context: BuyReconcileContext
): Promise<void> {
  if (inputs.consumeTxId) {
    const consume = await Repo.transactions.get(inputs.consumeTxId);
    switch (consume?.status) {
      case ITransactionStatus.Completed:
        // The consume completion normally completes the buy. This covers a completion whose tagging failed.
        await updateBuyPhase(row.id, 'completed', { consumeTxId: consume.id });
        return;
      case ITransactionStatus.Queued:
      case ITransactionStatus.GeneratingTransaction:
        context.kickTransactions?.();
        return;
      default:
        // The consume failed or is gone: look for the note again and queue a new consume.
        break;
    }
  }

  const tokenAmount = inputs.tokenAmount;
  if (!isBaseUnits(tokenAmount)) return;
  if (!context.claimableAccountId || !compareAccountIds(context.claimableAccountId, row.accountId)) return;
  const amount = BigInt(tokenAmount);
  const note = (context.claimableNotes ?? []).find(
    candidate =>
      (candidate.id === inputs.midenNoteId || !takenNoteIds.has(candidate.id)) && matchesBoughtNote(candidate, amount)
  );
  if (!note) return;

  const consumeId =
    note.isBeingClaimed && note.claimingTxId
      ? note.claimingTxId
      : await initiateConsumeTransaction(row.accountId, note, isDelegateProofEnabled());
  await linkConsumeRow(consumeId, row, inputs, note.id);
  await updateBuyPhase(row.id, 'consuming', { midenNoteId: note.id, consumeTxId: consumeId });
  console.info('[buy]', 'queued consume of bought note', { id: row.id, consumeTxId: consumeId });
  context.kickTransactions?.();
}

/** The Miden-side claim hash of a claimed deposit. `undefined` when the indexer gives no hash or an all-zero hash. */
function claimHashOf(deposit: AgglayerDeposit): string | undefined {
  const claimHash = deposit.claim_tx_hash?.trim();
  if (!claimHash || ZERO_TX_HASH.test(claimHash)) return undefined;
  return claimHash;
}

/**
 * Follow the Agglayer deposit of a `bridging` row. The indexer lists the deposits to the EVM form of the Miden
 * account, and the deposit of this buy has the relay transaction as its `tx_hash`. When the indexer shows the deposit
 * as claimed on Miden, move the row to `consuming` and look for the bridged note. Reads are at most one each
 * `BUY_INDEXER_POLL_INTERVAL_MS` for each row. An indexer fault goes to the caller, and the next read retries.
 */
async function trackDeposit(
  row: ITransaction,
  inputs: IBuyExtraInputs,
  takenNoteIds: ReadonlySet<string>,
  context: BuyReconcileContext
): Promise<void> {
  const relayTxHash = inputs.relayTxHash;
  // Without the relay hash, no deposit can match. The 7-day timeout closes the row.
  if (!relayTxHash) return;
  const now = Date.now();
  const polledAt = indexerPolledAt.get(row.id);
  if (polledAt !== undefined && now - polledAt < BUY_INDEXER_POLL_INTERVAL_MS) return;
  indexerPolledAt.set(row.id, now);

  const destAddress = midenAccountHexToEvmAddress(midenAccountIdToHex(row.accountId));
  const deposits = await fetchDeposits(destAddress);
  const deposit = deposits.find(candidate => sameTxHash(candidate.tx_hash, relayTxHash));
  if (!deposit) return;
  if (!seenDeposits.has(row.id)) {
    seenDeposits.add(row.id);
    console.info('[buy]', 'indexer shows deposit', {
      id: row.id,
      depositCnt: deposit.deposit_cnt,
      ready: isAgglayerDepositReady(deposit)
    });
  }
  if (!isAgglayerDepositClaimed(deposit)) return;

  const claimTxHash = claimHashOf(deposit);
  const patch: Partial<IBuyExtraInputs> = claimTxHash !== undefined ? { claimTxHash } : {};
  await updateBuyPhase(row.id, 'consuming', patch);
  indexerPolledAt.delete(row.id);
  seenDeposits.delete(row.id);
  await consumeBoughtNote(row, { ...inputs, ...patch, phase: 'consuming' }, takenNoteIds, context);
}

async function reconcileRow(
  row: ITransaction,
  inputs: IBuyExtraInputs,
  takenNoteIds: ReadonlySet<string>,
  context: BuyReconcileContext
): Promise<void> {
  if (row.restoredFromBackup) {
    await updateBuyPhase(row.id, 'failed', { error: RESTORED_BUY_UNVERIFIABLE });
    return;
  }
  if (Date.now() - row.initiatedAt * 1000 > BUY_ORDER_MAX_AGE_MS) {
    await updateBuyPhase(row.id, 'failed', { error: BUY_TIMED_OUT });
    return;
  }

  // The backend order is terminal (`deposited`) before the row gets to these phases, so only the wallet moves them.
  switch (inputs.phase) {
    case 'bridging':
      await trackDeposit(row, inputs, takenNoteIds, context);
      return;
    case 'consuming':
      await consumeBoughtNote(row, inputs, takenNoteIds, context);
      return;
    default:
      break;
  }

  const order = await getBuyOrder(inputs.orderId);
  switch (order.state) {
    case 'checkout':
      await updateBuyPhase(row.id, 'payment');
      return;
    case 'awaiting_signature':
      await updateBuyPhase(row.id, 'funds-arriving', tokenPatch(order));
      // Sign even when the row is past this phase: a reverted relay sends the order back here.
      await signIfAsked(row, inputs, order);
      return;
    case 'signed':
      await updateBuyPhase(row.id, 'funds-arriving', tokenPatch(order));
      return;
    case 'relay_sent':
      await updateBuyPhase(row.id, 'bridge-sent', tokenPatch(order));
      return;
    case 'deposited': {
      const patch = tokenPatch(order);
      await updateBuyPhase(row.id, 'bridging', patch);
      await trackDeposit(row, { ...inputs, ...patch, phase: 'bridging' }, takenNoteIds, context);
      return;
    }
    case 'failed':
    case 'expired':
    case 'cancelled':
      await updateBuyPhase(row.id, 'failed', { error: order.error ?? `The buy order was ${order.state}.` });
      return;
  }
}

/** One pass over every open buy row. A failure on one row does not stop the others. */
export async function reconcileBuyOrders(context: BuyReconcileContext = {}): Promise<void> {
  const rows = await Repo.transactions.filter(tx => tx.type === 'buy').toArray();
  // A note that one buy row already claims is never matched to another buy of the same amount.
  const takenNoteIds = new Set<string>();
  for (const row of rows) {
    const inputs: IBuyExtraInputs | undefined = row.extraInputs;
    if (inputs?.midenNoteId) takenNoteIds.add(inputs.midenNoteId);
  }
  const open = rows.filter(row => {
    const inputs: IBuyExtraInputs | undefined = row.extraInputs;
    return isOpenPhase(inputs?.phase);
  });
  open.sort((a, b) => a.initiatedAt - b.initiatedAt);

  for (const row of open) {
    const inputs: IBuyExtraInputs = row.extraInputs;
    try {
      await reconcileRow(row, inputs, takenNoteIds, context);
    } catch (error) {
      // Backend and network faults are transient. The row stays open until the next tick or its timeout.
      console.warn('[buy]', 'reconcile failed', { id: row.id, error });
    }
  }
}
