/**
 * Start a fiat sale and move every open sell row along.
 *
 * A sale has three owners. The wallet signs the relay batch and bridges the token out of Miden through Agglayer. The
 * Agglayer auto-claimer claims the exit on Ethereum, so the token arrives at the account's own EVM address. The
 * backend then relays the signed transfer to Transak's deposit address and follows the Transak order to its end.
 *
 * The wallet does these things here:
 * - `startSellOrder` signs the relay batch first, then queues the bridge-out and makes the tracking row. The
 *   bridge-out row carries the backend order id from the write that queues it, so one order can never get a second
 *   bridge-out.
 * - `reconcileSellOrders` copies the state of the bridge-out row, of the Agglayer exit and of the backend order onto
 *   the tracking row as a sell phase, for the status page. It signs again when the backend asks for a new signature.
 */
import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { findAgglayerExitDeposit, isAgglayerDepositClaimed } from 'lib/agglayer/status';
import type { GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import * as Repo from 'lib/miden/repo';
import { BackendOrder, BuyApiError, getOrder } from 'lib/onramp/buy-api';
import { midenAccountIdToHex } from 'lib/onramp/buy-batch';
import { SellSignRefusal, SellSignRefusedError, signSellOrder } from 'lib/onramp/sell-signer';
import type { SellToken } from 'lib/onramp/sell-token';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { compareAccountIds } from './utils';
import {
  IBridgedSendExtraInputs,
  ISellDepositSource,
  ISellExtraInputs,
  ISellFailure,
  ISellOrderLink,
  ISellPhase,
  ITransaction,
  ITransactionStatus,
  SELL_PHASES
} from '../db/types';
import { updateSellPhase } from '../transaction/complete';
import { isUnconfirmedFailure } from '../transaction/constants';
import { initiateSellTransaction } from '../transaction/initiate';

/** A sell row that is not terminal after this time is failed. */
export const SELL_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The time between two backend reads while a sale starts. */
export const SELL_START_POLL_MS = 3_000;
/** The time that the backend has to prepare the relay values after Confirm. */
export const SELL_PREPARE_TIMEOUT_MS = 5 * 60_000;
/**
 * Minimum time between two backend reads for one row. The bridge-out takes about 30 minutes, so the watcher tick
 * is too often for the backend.
 */
export const SELL_BACKEND_POLL_INTERVAL_MS = 20_000;
/** Minimum time between two Agglayer indexer reads for one row. */
export const SELL_INDEXER_POLL_INTERVAL_MS = 60_000;

/** The backend states in which a sell order stops for good before its relay is mined. */
export type SellEndedState = 'failed' | 'expired' | 'cancelled';

/** Why a sale did not start. */
export type SellStartFailure =
  | { kind: 'refused'; reason: SellSignRefusal }
  | { kind: 'order'; state: SellEndedState; message: string | null }
  | { kind: 'timeout' }
  /** The page closed before the signature. Nothing was signed and nothing left the wallet. */
  | { kind: 'stopped' }
  /** The relay is signed, but the bridge-out could not be queued. Nothing left the wallet. */
  | { kind: 'bridge'; message: string };

export class SellStartError extends Error {
  readonly failure: SellStartFailure;

  constructor(failure: SellStartFailure) {
    super(`Sell start failed: ${failure.kind}`);
    this.name = 'SellStartError';
    this.failure = failure;
  }
}

export interface StartSellOrderInput {
  account: { publicKey: string; evmAddress: `0x${string}` };
  /** The backend order id. */
  orderId: string;
  /** The deposit that the Transak widget named: the one source of truth for the signature. */
  deposit: { address: string; amount: string };
  depositSource: ISellDepositSource;
  /** The token and the amount, from `resolveSellToken`. */
  token: SellToken;
  guardianProvider: GuardianAccountProvider;
  /** Start the transaction queue after the bridge-out is queued. */
  kickTransactions: () => void;
  /** False after the page closed. It is read until the signature; after the signature the start always finishes. */
  isLive?: () => boolean;
}

/** The starts in progress in this realm, by backend order id. A second start for an order joins the first. */
const starts = new Map<string, Promise<string>>();

/**
 * Signing values already signed in this realm, as in `buy-order.ts`: the backend gives the same values on each poll
 * until it has the signature.
 */
const signedBatches = new Set<string>();
const backendPolledAt = new Map<string, number>();
const indexerPolledAt = new Map<string, number>();

/**
 * Clicks "Yes, I have paid" in the Transak widget of an order. It gives null when no widget is open for the order,
 * else the result of the click.
 */
export type SellPaidClick = (orderId: string) => Promise<boolean | null>;

/**
 * The click of the page that keeps a widget open (`settleKeptWidget` in `lib/onramp/sell-widget`). The page sets it,
 * because this module also loads where no widget can exist and must not import the widget code.
 */
let paidClick: SellPaidClick | null = null;

/** Set the click for a widget that drew its deposit page and stays open until the relay. */
export function setSellPaidClick(click: SellPaidClick | null): void {
  paidClick = click;
}

/** Test-only: forget the starts, the signed batches, the poll state and the paid click. */
export function __resetSellOrderMemoryForTests(): void {
  starts.clear();
  signedBatches.clear();
  backendPolledAt.clear();
  indexerPolledAt.clear();
  paidClick = null;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function endedStateOf(order: Pick<BackendOrder, 'state'>): SellEndedState | null {
  switch (order.state) {
    case 'failed':
    case 'expired':
    case 'cancelled':
      return order.state;
    default:
      return null;
  }
}

const sellLinkOf = (row: ITransaction): ISellOrderLink | undefined => {
  if (row.type !== 'bridged-send') return undefined;
  const inputs: IBridgedSendExtraInputs | undefined = row.extraInputs;
  return inputs?.sellOrder;
};

const sellInputsOf = (row: ITransaction): ISellExtraInputs | undefined => {
  if (row.type !== 'sell') return undefined;
  const inputs: ISellExtraInputs | undefined = row.extraInputs;
  return inputs;
};

/** The bridge-out row of a backend order, or `undefined` when no bridge-out was queued for it. */
function findSellBridgeOut(orderId: string, accountId: string): Promise<ITransaction | undefined> {
  return Repo.transactions
    .where('type')
    .equals('bridged-send')
    .filter(row => sellLinkOf(row)?.orderId === orderId && compareAccountIds(row.accountId, accountId))
    .first();
}

/** Make the tracking row of a bridge-out that carries a sale. Idempotent per order id. */
async function trackSellBridgeOut(bridge: ITransaction, link: ISellOrderLink): Promise<string> {
  const inputs: IBridgedSendExtraInputs = bridge.extraInputs;
  return initiateSellTransaction(bridge.accountId, {
    ...link,
    faucetId: bridge.faucetId ?? inputs.sourceFaucetId,
    tokenAmount: (bridge.amount ?? 0n).toString(),
    evmAddress: inputs.destinationAddress,
    bridgeTxId: bridge.id,
    ...(inputs.agglayerExitTxHash !== undefined ? { bridgeExitTxHash: inputs.agglayerExitTxHash } : {})
  });
}

/**
 * Read the order until the backend has its relay values, or already has the signature. `sign` is false when a
 * signature is in place. Throw when the order ends, when the page closes or at the timeout.
 */
async function waitForSignable(
  orderId: string,
  isLive: () => boolean
): Promise<{ order: BackendOrder; sign: boolean }> {
  const attempts = Math.ceil(SELL_PREPARE_TIMEOUT_MS / SELL_START_POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(SELL_START_POLL_MS);
    if (!isLive()) throw new SellStartError({ kind: 'stopped' });
    let order: BackendOrder;
    try {
      order = await getOrder(orderId);
    } catch {
      // A failed read is tried again at the next poll.
      continue;
    }
    const ended = endedStateOf(order);
    if (ended !== null) throw new SellStartError({ kind: 'order', state: ended, message: order.error });
    switch (order.state) {
      case 'awaiting_signature':
        if (order.prepare !== null) return { order, sign: true };
        break;
      case 'signed':
      case 'relay_sent':
      case 'deposited':
        return { order, sign: false };
      default:
        break;
    }
  }
  throw new SellStartError({ kind: 'timeout' });
}

async function runStart(input: StartSellOrderInput): Promise<string> {
  const { account, orderId, deposit, token } = input;
  const isLive = input.isLive ?? (() => true);

  // A bridge-out that exists for this order is the sale: never queue a second one.
  const queued = await findSellBridgeOut(orderId, account.publicKey);
  const queuedLink = queued === undefined ? undefined : sellLinkOf(queued);
  if (queued !== undefined && queuedLink !== undefined) {
    const id = await trackSellBridgeOut(queued, queuedLink);
    input.kickTransactions();
    return id;
  }

  // The signature goes first: a refusal then costs the user nothing.
  const { order, sign } = await waitForSignable(orderId, isLive);
  // The exit must release the amount that the backend relays. The signer makes this check for the values that it
  // signs; this check also covers an order that has its signature already.
  if (order.tokenAmount !== null && BigInt(order.tokenAmount) !== token.evmAmount) {
    throw new SellStartError({ kind: 'refused', reason: 'amount' });
  }
  if (sign) {
    if (!isLive()) throw new SellStartError({ kind: 'stopped' });
    try {
      await signSellOrder({
        account: {
          publicKey: account.publicKey,
          evmAddress: account.evmAddress,
          midenAccountHex: midenAccountIdToHex(account.publicKey)
        },
        // The WIDGET values, not the backend values: `signSellOrder` refuses a backend that disagrees with them.
        depositAddress: deposit.address,
        cryptoAmount: deposit.amount,
        order
      });
    } catch (error) {
      if (error instanceof SellSignRefusedError) throw new SellStartError({ kind: 'refused', reason: error.reason });
      throw error;
    }
  }

  const link: ISellOrderLink = {
    orderId,
    cryptoAmount: deposit.amount,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    depositAddress: deposit.address,
    depositSource: input.depositSource,
    ...(typeof order.autoExpiresAt === 'number' ? { autoExpiresAt: order.autoExpiresAt } : {})
  };

  let bridgeTxId: string;
  try {
    // The bridge-out releases the token at the account's own EVM address. The backend relays it from there.
    bridgeTxId = await initiateB2AggBridge({
      amount: token.amount,
      faucetId: token.faucetId,
      destinationAddress: account.evmAddress,
      senderPublicKey: account.publicKey,
      guardianProvider: input.guardianProvider,
      sellOrder: link
    });
  } catch (error) {
    console.warn('[sell]', 'bridge-out not queued', { orderId, error });
    throw new SellStartError({ kind: 'bridge', message: error instanceof Error ? error.message : String(error) });
  }

  const bridge = await Repo.transactions.get(bridgeTxId);
  if (bridge === undefined) throw new SellStartError({ kind: 'bridge', message: 'The bridge-out row is missing.' });
  const id = await trackSellBridgeOut(bridge, link);
  console.info('[sell]', 'started', { id, orderId, bridgeTxId });
  input.kickTransactions();
  return id;
}

/**
 * Start a sale after the user confirmed it: sign the relay batch, queue the bridge-out, make the tracking row and
 * give its id. A second call for the same backend order, in the same run or after a restart, gives the same row and
 * queues no second bridge-out. Throw `SellStartError` when the sale did not start.
 */
export function startSellOrder(input: StartSellOrderInput): Promise<string> {
  const running = starts.get(input.orderId);
  if (running !== undefined) return running;
  const start = runStart(input).finally(() => starts.delete(input.orderId));
  starts.set(input.orderId, start);
  return start;
}

/** What the watcher knows about a sale at one tick. */
export interface SellEvidence {
  /** The phase of the row now. The result is never before it. */
  current: ISellPhase;
  /** The bridge-out row: in progress, completed on Miden, failed for certain, or gone. */
  bridge: 'pending' | 'completed' | 'failed' | 'missing';
  bridgeError?: string;
  /** True when the Agglayer indexer shows the exit of the bridge-out as claimed on Ethereum. */
  exitClaimed: boolean;
  /** The backend order, when this tick read it. */
  order?: Pick<BackendOrder, 'state' | 'transakStatus' | 'error'>;
}

export interface SellProgress {
  phase: ISellPhase;
  failure?: ISellFailure;
  error?: string;
}

const failed = (failure: ISellFailure, error?: string | null): SellProgress => ({
  phase: 'failed',
  failure,
  ...(error ? { error } : {})
});

function transakFailureOf(status: string | undefined): ISellFailure | undefined {
  switch (status) {
    case 'FAILED':
      return 'transak-failed';
    case 'CANCELLED':
      return 'transak-cancelled';
    case 'EXPIRED':
      return 'transak-expired';
    case 'REFUNDED':
      return 'transak-refunded';
    default:
      return undefined;
  }
}

function orderFailureOf(state: SellEndedState): ISellFailure {
  switch (state) {
    case 'failed':
      return 'order-failed';
    case 'expired':
      return 'order-expired';
    case 'cancelled':
      return 'order-cancelled';
  }
}

/** The furthest phase that the evidence proves, without the failures. */
function reachedPhase(evidence: SellEvidence, transakStatus: string | undefined): ISellPhase {
  if (transakStatus === 'PENDING_DELIVERY_FROM_TRANSAK') return 'received';
  switch (evidence.order?.state) {
    case 'relay_sent':
    case 'deposited':
      return 'sent';
    default:
      break;
  }
  if (evidence.exitClaimed) return 'on-ethereum';
  return evidence.bridge === 'completed' ? 'bridging' : 'submitting';
}

/**
 * The phase of a sale from the bridge-out row, the Agglayer exit and the backend order.
 *
 * A completed payout wins. A backend `expired` is next. Then Transak's own end states, because after the deposit
 * only `transakStatus` moves. The other backend end states are next. A bridge-out failure counts only while the row still waits for that transaction: later evidence proves
 * that the token left Miden.
 */
export function deriveSellProgress(evidence: SellEvidence): SellProgress {
  const transakStatus = evidence.order?.transakStatus?.trim().toUpperCase();
  if (transakStatus === 'COMPLETED') return { phase: 'completed' };
  const ended = evidence.order === undefined ? null : endedStateOf(evidence.order);
  // The backend sets `expired` only for a signed sale that it did not relay in time, so the token did not go to
  // Transak. This cause is more exact than the `EXPIRED` status that Transak can show at the same time.
  if (ended === 'expired') return failed('order-expired', evidence.order?.error);
  const transakFailure = transakFailureOf(transakStatus);
  if (transakFailure !== undefined) return failed(transakFailure, evidence.order?.error);

  if (ended !== null) return failed(orderFailureOf(ended), evidence.order?.error);

  const reached = reachedPhase(evidence, transakStatus);
  if (evidence.current === 'submitting' && reached === 'submitting') {
    switch (evidence.bridge) {
      case 'failed':
        return failed('bridge-failed', evidence.bridgeError);
      case 'missing':
        return failed('bridge-missing');
      default:
        break;
    }
  }
  return { phase: SELL_PHASES.indexOf(reached) > SELL_PHASES.indexOf(evidence.current) ? reached : evidence.current };
}

function signingKey(order: BackendOrder): string | undefined {
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

/**
 * Sign again when the backend is back at `awaiting_signature`: new relay values, or a start that stopped between
 * its row and its signature. The row holds the deposit that the widget named, and the signer checks the backend
 * values against it.
 */
async function signIfAsked(row: ITransaction, inputs: ISellExtraInputs, order: BackendOrder): Promise<void> {
  const key = signingKey(order);
  if (!key || signedBatches.has(key)) return;

  const store = useWalletStore.getState();
  if (store.status !== WalletStatus.Ready) return;
  const account = store.accounts.find(candidate => compareAccountIds(candidate.publicKey, row.accountId));
  if (!account?.evmAddress) {
    console.warn('[sell]', 'account has no EVM address; cannot sign', { id: row.id });
    return;
  }

  signedBatches.add(key);
  try {
    const state = await signSellOrder({
      account: {
        publicKey: account.publicKey,
        evmAddress: account.evmAddress,
        midenAccountHex: midenAccountIdToHex(account.publicKey)
      },
      depositAddress: inputs.depositAddress,
      cryptoAmount: inputs.cryptoAmount,
      order
    });
    console.info('[sell]', 'signed relay batch', { id: row.id, orderId: order.id, state });
  } catch (error) {
    switch (true) {
      case error instanceof SellSignRefusedError:
        // Keep the key: the same values are refused again. New values make a new key.
        console.warn('[sell]', 'refused to sign', { id: row.id, reason: error.reason });
        break;
      case error instanceof BuyApiError && error.status !== undefined:
        // The backend answered. Its next poll gives fresh values if these were stale.
        console.warn('[sell]', 'signature rejected', { id: row.id, status: error.status, message: error.message });
        break;
      default:
        // No answer, or the vault failed: try the same values again on the next tick.
        signedBatches.delete(key);
        console.warn('[sell]', 'signing failed', { id: row.id, error });
        break;
    }
  }
}

/** True when `minIntervalMs` passed since the last read that `polledAt` has for the row. The read is then booked. */
function dueForPoll(polledAt: Map<string, number>, rowId: string, minIntervalMs: number): boolean {
  const now = Date.now();
  const last = polledAt.get(rowId);
  if (last !== undefined && now - last < minIntervalMs) return false;
  polledAt.set(rowId, now);
  return true;
}

function bridgeStateOf(bridge: ITransaction | undefined): SellEvidence['bridge'] {
  if (bridge === undefined) return 'missing';
  switch (bridge.status) {
    case ITransactionStatus.Completed:
      return 'completed';
    case ITransactionStatus.Failed:
      // A failure whose outcome is not known can still land. The row waits for the verdict.
      return isUnconfirmedFailure(bridge) ? 'pending' : 'failed';
    default:
      return 'pending';
  }
}

/**
 * True when the exit of the bridge-out is claimed on Ethereum. The bridge poll of the wallet writes that on the
 * bridge-out row. Without it, ask the indexer for the deposit that carries the exit hash of this row, at most one
 * time each `SELL_INDEXER_POLL_INTERVAL_MS`.
 */
async function readExitClaim(
  row: ITransaction,
  bridge: ITransaction
): Promise<{ claimed: boolean; claimTxHash?: string }> {
  const inputs: IBridgedSendExtraInputs = bridge.extraInputs;
  if (inputs.claimStatus === 'claimed') {
    return { claimed: true, ...(inputs.claimTxHash !== undefined ? { claimTxHash: inputs.claimTxHash } : {}) };
  }
  const exitTxHash = inputs.agglayerExitTxHash;
  if (!exitTxHash || !inputs.destinationAddress) return { claimed: false };
  if (!dueForPoll(indexerPolledAt, row.id, SELL_INDEXER_POLL_INTERVAL_MS)) return { claimed: false };
  // The indexer getters read the bridge config, and this pass runs with no user action.
  await initBridgeConfig();
  const deposit = await findAgglayerExitDeposit(inputs.destinationAddress, exitTxHash, inputs.agglayerDepositCnt);
  if (deposit === null || !isAgglayerDepositClaimed(deposit)) return { claimed: false };
  const claimTxHash = deposit.claim_tx_hash?.trim();
  return { claimed: true, ...(claimTxHash ? { claimTxHash } : {}) };
}

export interface SellReconcileContext {
  /** Start the transaction queue while a bridge-out waits in it. */
  kickTransactions?: () => void;
}

async function reconcileRow(row: ITransaction, inputs: ISellExtraInputs, context: SellReconcileContext): Promise<void> {
  if (row.restoredFromBackup) {
    await updateSellPhase(row.id, 'failed', { failure: 'restored' });
    return;
  }
  if (Date.now() - row.initiatedAt * 1000 > SELL_ORDER_MAX_AGE_MS) {
    await updateSellPhase(row.id, 'failed', { failure: 'timeout' });
    return;
  }

  const bridge = await Repo.transactions.get(inputs.bridgeTxId);
  const bridgeState = bridgeStateOf(bridge);
  if (bridge !== undefined && bridgeState === 'pending' && bridge.status !== ITransactionStatus.Failed) {
    context.kickTransactions?.();
  }

  let order: BackendOrder | undefined;
  if (dueForPoll(backendPolledAt, row.id, SELL_BACKEND_POLL_INTERVAL_MS)) {
    try {
      order = await getOrder(inputs.orderId);
    } catch (error) {
      // The backend is not reachable. The bridge-out and the exit still move the row.
      console.warn('[sell]', 'order read failed', { id: row.id, error });
    }
  }
  if (order?.state === 'awaiting_signature') await signIfAsked(row, inputs, order);

  let exit: { claimed: boolean; claimTxHash?: string } = { claimed: false };
  const beforeOnEthereum = SELL_PHASES.indexOf(inputs.phase) < SELL_PHASES.indexOf('on-ethereum');
  if (bridge !== undefined && bridgeState === 'completed' && beforeOnEthereum) {
    try {
      exit = await readExitClaim(row, bridge);
    } catch (error) {
      console.warn('[sell]', 'exit read failed', { id: row.id, error });
    }
  }

  const progress = deriveSellProgress({
    current: inputs.phase,
    bridge: bridgeState,
    bridgeError: bridge?.error,
    exitClaimed: exit.claimed,
    order
  });

  const patch: Partial<Omit<ISellExtraInputs, 'phase' | 'phaseTimestamps'>> = {
    ...(bridge?.transactionId ? { bridgeTransactionId: bridge.transactionId } : {}),
    ...(exit.claimTxHash !== undefined ? { claimTxHash: exit.claimTxHash } : {}),
    ...(order?.relayTxHash ? { relayTxHash: order.relayTxHash } : {}),
    ...(order?.transakStatus ? { transakStatus: order.transakStatus } : {}),
    ...(typeof order?.autoExpiresAt === 'number' ? { autoExpiresAt: order.autoExpiresAt } : {}),
    ...(progress.failure !== undefined ? { failure: progress.failure } : {}),
    ...(progress.error !== undefined ? { error: progress.error } : {})
  };

  // A widget that drew its deposit page waits for its "Yes, I have paid" click until the relay is out.
  const relayed = SELL_PHASES.indexOf(progress.phase) >= SELL_PHASES.indexOf('sent');
  if (relayed && inputs.depositSource === 'page' && inputs.paidClicked === undefined && paidClick !== null) {
    const clicked = await paidClick(inputs.orderId);
    if (clicked !== null) patch.paidClicked = clicked;
  }

  await updateSellPhase(row.id, progress.phase, patch);
  switch (progress.phase) {
    case 'completed':
    case 'failed':
      backendPolledAt.delete(row.id);
      indexerPolledAt.delete(row.id);
      break;
    default:
      break;
  }
}

/**
 * Make the tracking row of each bridge-out that carries a sale and has none: the app stopped between the two
 * writes of a start. A start in progress in this realm makes its own row.
 */
async function adoptUntrackedBridgeOuts(sellRows: readonly ITransaction[]): Promise<ITransaction[]> {
  const tracked = new Set(sellRows.map(row => sellInputsOf(row)?.orderId));
  const bridgeOuts = await Repo.transactions
    .where('type')
    .equals('bridged-send')
    .filter(row => sellLinkOf(row) !== undefined)
    .toArray();
  const adopted: ITransaction[] = [];
  for (const bridge of bridgeOuts) {
    const link = sellLinkOf(bridge);
    if (link === undefined || tracked.has(link.orderId) || starts.has(link.orderId) || bridge.restoredFromBackup) {
      continue;
    }
    const id = await trackSellBridgeOut(bridge, link);
    tracked.add(link.orderId);
    console.info('[sell]', 'tracked a bridge-out that had no sell row', { id, orderId: link.orderId });
    const row = await Repo.transactions.get(id);
    if (row !== undefined) adopted.push(row);
  }
  return adopted;
}

function isOpenPhase(phase: ISellPhase | undefined): boolean {
  return phase !== undefined && phase !== 'completed' && phase !== 'failed';
}

/** One pass over every open sell row. A failure on one row does not stop the others. */
export async function reconcileSellOrders(context: SellReconcileContext = {}): Promise<void> {
  const rows = await Repo.transactions.filter(tx => tx.type === 'sell').toArray();
  try {
    rows.push(...(await adoptUntrackedBridgeOuts(rows)));
  } catch (error) {
    console.warn('[sell]', 'bridge-out adoption failed', error);
  }
  const open = rows.filter(row => isOpenPhase(sellInputsOf(row)?.phase));
  open.sort((a, b) => a.initiatedAt - b.initiatedAt);

  for (const row of open) {
    const inputs = sellInputsOf(row);
    if (inputs === undefined) continue;
    try {
      await reconcileRow(row, inputs, context);
    } catch (error) {
      // Backend and network faults are transient. The row stays open until the next tick or its timeout.
      console.warn('[sell]', 'reconcile failed', { id: row.id, error });
    }
  }
}
