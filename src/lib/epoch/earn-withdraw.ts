import { EpochIntentSDK, TaskType, ActionType } from '@epoch-protocol/epoch-intents-sdk';
import { type Address, parseUnits } from 'viem';
import { sepolia } from 'viem/chains';

import {
  findPendingBridgeInByEarnWithdrawTxId,
  initiateEarnWithdrawTransaction,
  registerPendingBridgeIn,
  resolveBridgeInNoteId,
  updateEarnWithdrawPhase
} from 'lib/miden/activity';
import type { IEarnWithdrawExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';

import { normalizeMidenIdToHex } from './bridge';
import { BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS } from './bridgeable-token';
import { EPOCH_ALLOCATOR_URL, MIDEN_DESTINATION_CHAIN_ID } from './config';
import { EARN_PROTOCOL_HASH, EARN_UNDERLYING, resolveEarnIntentOutcome } from './earn';
import { buildVaultEvmWalletClient } from './evm-account';
import { getEpochReadOnlySdk, ensureEpochSmartAccount } from './sdk';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Non-terminal `earn-withdraw` phases the reconciler resumes; terminal ones are skipped. */
const NON_TERMINAL_WITHDRAW_PHASES = new Set(['redeeming', 'delivering']);

/** Drop reconciler-orphaned rows after this age (mirrors the bridge-in registry TTL). */
const WITHDRAW_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GaslessEarnWithdrawalArgs {
  midenAccountPublicKey: string;
  evmAddress: string;
  marketUid: string;
  underlyingAddress: string;
  /** Human-decimal withdrawable amount returned by the positions API. */
  amount: string;
  underlyingDecimals: number;
  /** Fired once the tracking `earn-withdraw` row exists (before the intent work),
   * so the caller can navigate to the generating-transaction screen — mirrors
   * `openEarnPosition`'s callback. */
  onRowCreated?: (txId: string) => void;
}

export interface GaslessEarnWithdrawalResult {
  /** id of the tracking `earn-withdraw` row created for this withdrawal. */
  txId: string;
  /** Epoch intent nonce driving delivery polling. */
  nonce: string;
  gaslessUsed: boolean;
}

interface GaslessEarnWithdrawalDeps {
  sdk?: EpochIntentSDK;
  ensureSmartAccount?: typeof ensureEpochSmartAccount;
  registerBridgeIn?: typeof registerPendingBridgeIn;
  initiateRow?: typeof initiateEarnWithdrawTransaction;
  updatePhase?: typeof updateEarnWithdrawPhase;
  /** Injectable delivery poller (tests pass a no-op). */
  startDeliveryPoll?: typeof pollEarnWithdrawDelivery;
}

function isEvmAddress(value: string): value is Address {
  return EVM_ADDRESS_RE.test(value);
}

function asAddress(value: string, label: string): Address {
  if (!isEvmAddress(value)) throw new Error(`${label} is not a valid EVM address.`);
  return value;
}

function parseWithdrawAmount(value: string, decimals: number): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('Withdraw amount is invalid.');
  const fraction = (match[2] ?? '').slice(0, decimals);
  return parseUnits(fraction ? `${match[1]}.${fraction}` : match[1]!, decimals);
}

/** Read the untyped `midenNoteId` field the allocator includes on EVM→Miden status entries. */
function extractMidenNoteId(results: unknown[]): string | undefined {
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const value: unknown = Reflect.get(result, 'midenNoteId');
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Build the direct lending-protocol withdrawal task (retained for reference / non-gasless path). */
export function buildEarnWithdrawTaskDataParams(args: {
  sponsorAddress: Address;
  marketUid: string;
  underlyingAddress: Address;
  amountAtomic: string;
  chainId: number;
}) {
  return {
    taskType: TaskType.ProtocolInteraction,
    intentData: {
      isNative: false,
      depositTokenAddress: args.underlyingAddress,
      tokenInAmount: args.amountAtomic,
      outputTokenAddress: args.underlyingAddress,
      minTokenOut: '0',
      destinationChainId: String(args.chainId),
      protocolHashIdentifier: EARN_PROTOCOL_HASH,
      recipient: args.sponsorAddress
    },
    extraDataTypestring: 'string marketUid,string action,string payAsset,bool isAll,bool simulate',
    extraData: {
      marketUid: args.marketUid,
      action: 'withdraw',
      payAsset: args.underlyingAddress,
      isAll: false,
      simulate: true
    }
  };
}

/**
 * Smart Withdraw: redeem an Epoch lending position and bridge the underlying back
 * to Miden as a single gasless intent (`sdk.helpers.executeActions`). A tracking
 * `earn-withdraw` row is created up front (phase `redeeming`); the returned nonce
 * is polled in the background to advance the row to `delivering`, and the bridged
 * note's auto-consume flips it to `received` (see `completeConsumeTransaction`).
 *
 * A failure up to and including the (irreversible) intent submit marks the row
 * `failed` before rethrowing. A failure in the POST-submit bookkeeping (nonce
 * persistence / bridge-in registration) is swallowed and the row is left
 * non-terminal `redeeming` — the intent is already in flight, so
 * `reconcileEarnWithdrawals` and the auto-consume path heal it rather than
 * falsely marking a live withdrawal `failed` (which is terminal and unrecoverable).
 */
export async function gaslessEarnWithdrawalToMiden(
  args: GaslessEarnWithdrawalArgs,
  deps: GaslessEarnWithdrawalDeps = {}
): Promise<GaslessEarnWithdrawalResult> {
  // --- Validation (throws before any row is created) ---
  const sponsorAddress = asAddress(args.evmAddress, 'Position owner');
  const underlyingAddress = asAddress(args.underlyingAddress, 'Underlying token');
  const midenRecipientHex = normalizeMidenIdToHex(args.midenAccountPublicKey);
  if (!args.midenAccountPublicKey) throw new Error('A Miden destination account is required.');
  if (!args.marketUid) throw new Error('The lending market identifier is missing.');
  if (
    underlyingAddress.toLowerCase() !== EARN_UNDERLYING.toLowerCase() ||
    args.underlyingDecimals !== BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS
  ) {
    throw new Error('Gasless withdrawal only supports the configured USDC Earn market.');
  }
  const chainId = Number(args.marketUid.split(':')[1]);
  if (chainId !== sepolia.id) throw new Error('Gasless withdrawal currently supports Sepolia only.');
  const amountAtomic = parseWithdrawAmount(args.amount, args.underlyingDecimals);
  if (amountAtomic <= 0n) throw new Error('Withdraw amount must be greater than zero.');

  const initiateRow = deps.initiateRow ?? initiateEarnWithdrawTransaction;
  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  const registerBridgeIn = deps.registerBridgeIn ?? registerPendingBridgeIn;
  const startDeliveryPoll = deps.startDeliveryPoll ?? pollEarnWithdrawDelivery;

  // The bridged funds land as the native Miden asset (the intent's `toToken`).
  const destinationFaucetId = await getNativeAssetId();

  // --- Create the tracking row (born Completed; lifecycle in extraInputs.phase) ---
  const txId = await initiateRow(
    args.midenAccountPublicKey,
    amountAtomic,
    sponsorAddress,
    args.marketUid,
    destinationFaucetId,
    args.amount,
    'USDC'
  );
  args.onRowCreated?.(txId);

  // --- Pre-submit + submit (reversible up to `executeActions` resolving) ---
  // Any failure in here means nothing durable was submitted (or there is no nonce
  // to track it), so the row is safely marked terminal `failed` and rethrown.
  let nonceString: string;
  try {
    const ensureSmartAccount = deps.ensureSmartAccount ?? ensureEpochSmartAccount;
    await ensureSmartAccount(args.midenAccountPublicKey, sponsorAddress);
    const walletClient = buildVaultEvmWalletClient(args.midenAccountPublicKey, sponsorAddress);
    const sdk =
      deps.sdk ??
      new EpochIntentSDK({
        apiBaseUrl: EPOCH_ALLOCATOR_URL,
        walletClient,
        allowGaslessSmartAccount: true
      });

    const status = await sdk.getWalletGaslessStatus(chainId);
    if (!status.is7702Capable) {
      throw new Error('Wallet/chain is not 7702-capable for a gasless withdrawal.');
    }
    if (status.needsSetup) {
      const setup = await sdk.convertToSmartAccount({ chainId });
      if (!setup.ok) throw new Error('Smart-account conversion failed for the gasless withdrawal.');
    }

    const native = await getNativeAssetId();
    // Point of no return: once this resolves with a nonce the Epoch intent is
    // submitted and the lending position is being redeemed — it must not be re-run.
    const { nonce } = await sdk.helpers.executeActions({
      action: ActionType.Withdraw,
      underlying: underlyingAddress,
      amount: amountAtomic.toString(),
      protocol: 'dummy-lending',
      swapAndBridge: {
        toToken: normalizeMidenIdToHex(native),
        toChainId: MIDEN_DESTINATION_CHAIN_ID,
        recipient: midenRecipientHex
      },
      gasless: true
    });
    nonceString = String(nonce);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updatePhase(txId, 'failed', { error: message }).catch((err: unknown) =>
      console.warn('[earn-withdraw] failed-phase patch failed', err)
    );
    throw error;
  }

  // --- Post-submit bookkeeping (intent already in flight — DO NOT mark failed) ---
  // The intent is live now, so NEITHER of the two post-submit writes below may mark the
  // row terminal `failed`. They are the row's two independent recovery anchors, and they
  // are written + caught INDEPENDENTLY so a single failed write cannot strand the row:
  //
  //   1. registerBridgeIn writes the nonce→txId registry entry (keyed to this row via
  //      earnWithdrawTxId). It runs FIRST because it is the durable proof-of-submit that
  //      `resumeEarnWithdrawal` falls back to when the row itself lost its nonce, and it
  //      also lets the auto-consume path flip the row to the terminal `received`.
  //   2. updatePhase records the nonce on the row so `reconcileEarnWithdrawals`→
  //      `resumeEarnWithdrawal` can re-register the bridge-in and re-poll after an app kill.
  //
  // Losing anchor 1 alone → resume recovers via anchor 2 (the row nonce). Losing anchor 2
  // alone → resume recovers the nonce from anchor 1 (the registry) and re-persists it, so
  // it still never fails a live withdrawal. Only losing BOTH (two independent aborted
  // writes) strands the row, which is why they are no longer chained in one all-or-nothing
  // try: previously a failed nonce-write skipped registerBridgeIn, killing both anchors.
  try {
    await registerBridgeIn(sponsorAddress, nonceString, {
      provider: 'epoch',
      sourceAmount: args.amount,
      sourceSymbol: 'USDC',
      intentNonce: nonceString,
      earnWithdrawTxId: txId
    });
  } catch (registrationError) {
    console.warn(
      '[earn-withdraw] bridge-in registration failed; row nonce + reconcile will recover',
      registrationError
    );
  }
  try {
    await updatePhase(txId, 'redeeming', { withdrawIntentNonce: nonceString });
  } catch (nonceError) {
    console.warn('[earn-withdraw] nonce persist failed; bridge-in registry + auto-consume will recover', nonceError);
  }
  startDeliveryPoll({ sponsorAddress, nonce: nonceString, txId });

  return { txId, nonce: nonceString, gaslessUsed: true };
}

interface DeliveryPollDeps {
  getSdk?: typeof getEpochReadOnlySdk;
  updatePhase?: typeof updateEarnWithdrawPhase;
  resolveNoteId?: typeof resolveBridgeInNoteId;
}

/**
 * Background-poll the Epoch allocator for the withdraw intent's fill. On a terminal
 * `done` status the row advances to `delivering` (the bridged note is en route; the
 * `received` flip happens on auto-consume); a terminal `failed` status marks the row
 * `failed`. Fire-and-forget, read-only SDK, self-terminating — mirrors
 * `pollEarnIntentStatus`.
 *
 * Polling is best-effort and bounded (`maxAttempts × intervalMs`, ~5 min by
 * default). On give-up it stops with the row left non-terminal ON PURPOSE and
 * leaves a breadcrumb: `reconcileEarnWithdrawals` restarts a fresh poll next
 * session, and the auto-consume path drives the authoritative terminal `received`
 * flip regardless — so a bridge slower than the poll window still heals; only the
 * cosmetic `delivering` phase and in-session late-failure detection are best-effort.
 *
 * Terminality is gated on the MIDEN (destination) leg via `resolveEarnIntentOutcome`.
 * This is the mirror image of the deposit poll: here the SEPOLIA leg is the SOURCE,
 * and it routinely completes (the position is redeemed) well before the bridged note
 * reaches Miden. Treating that as terminal stopped the poll early, so the allocator's
 * `midenNoteId` and any later destination-side failure were never observed.
 *
 * Ordering matters: the terminal phase patch runs BEFORE `resolveNoteId`. Note
 * resolution can tag an already-completed consume row, which flips this row to the
 * terminal `received` phase — doing it first and then writing `delivering` would
 * downgrade the row and strand it at "Delivering" forever. `updateEarnWithdrawPhase`
 * is monotonic and refuses that downgrade too; the ordering here just avoids relying
 * on the guard.
 */
export function pollEarnWithdrawDelivery(args: {
  sponsorAddress: `0x${string}`;
  nonce: string;
  txId: string;
  intervalMs?: number;
  maxAttempts?: number;
  deps?: DeliveryPollDeps;
}): void {
  const { sponsorAddress, nonce, txId, intervalMs = 3000, maxAttempts = 100, deps = {} } = args;
  const getSdk = deps.getSdk ?? getEpochReadOnlySdk;
  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  const resolveNoteId = deps.resolveNoteId ?? resolveBridgeInNoteId;
  let attempts = 0;
  const interval = setInterval(() => void tick(), intervalMs);

  async function tick(): Promise<void> {
    attempts += 1;
    let resolvedTerminally = false;
    try {
      if (!isEvmAddress(sponsorAddress)) {
        clearInterval(interval);
        return;
      }
      const sdk = await getSdk(sponsorAddress);
      const results = await sdk.getIntentStatus(sponsorAddress, nonce);
      const { outcome, source } = resolveEarnIntentOutcome(results, MIDEN_DESTINATION_CHAIN_ID);

      if (outcome !== 'pending') {
        clearInterval(interval);
        resolvedTerminally = true;
        // The EVM (source) leg carries the redeem/bridge tx hash.
        const evmTxHash = source?.transactionHash || undefined;
        if (outcome === 'done') {
          await updatePhase(txId, 'delivering', evmTxHash ? { evmTxHash } : undefined);
        } else {
          await updatePhase(txId, 'failed', { error: 'The withdrawal intent failed on Epoch.' });
        }
      }

      // Learn the bridged note id as soon as it appears so an already-completed
      // consume row (delivery-before-poll race) gets tagged + flipped to received.
      // Runs LAST so the `received` flip is never overwritten by `delivering`.
      const midenNoteId = extractMidenNoteId(results);
      if (midenNoteId) await resolveNoteId(nonce, midenNoteId).catch(() => undefined);
    } catch (err) {
      console.warn('[earn-withdraw] delivery poll failed', err);
    }
    // Best-effort give-up: stop polling once the attempt budget is spent. The row is
    // deliberately left non-terminal (`redeeming`/`delivering`) — `reconcileEarnWithdrawals`
    // restarts a fresh poll next session and auto-consume drives the terminal `received`
    // flip regardless. Breadcrumb only when we stopped WITHOUT resolving this tick.
    if (!resolvedTerminally && attempts >= maxAttempts) {
      clearInterval(interval);
      console.warn('[earn-withdraw] delivery poll gave up after max attempts; row left non-terminal for reconcile', {
        txId,
        nonce,
        attempts
      });
    }
  }
}

interface ResumeDeps extends DeliveryPollDeps {
  registerBridgeIn?: typeof registerPendingBridgeIn;
  startDeliveryPoll?: typeof pollEarnWithdrawDelivery;
  findBridgeIn?: typeof findPendingBridgeInByEarnWithdrawTxId;
}

/**
 * Idempotently resume a non-terminal `earn-withdraw` row after an app restart.
 * If the redeem intent was submitted, the bridge-in is re-registered and delivery
 * polling restarts. The proof-of-submit is the intent nonce: normally read off the
 * row (`withdrawIntentNonce`), but if the row lost it (a teardown between the two
 * post-submit writes) it is recovered from the bridge-in registry, which is written
 * first and keyed to this row's id — so a live withdrawal is never falsely failed
 * (a false terminal `failed` would permanently block the auto-consume `received`
 * flip and hide the delivered funds). Only when NEITHER the row nor the registry
 * has the nonce (app killed mid-solve, intent never submitted) is the row marked
 * `failed`. No-op on terminal rows.
 */
export async function resumeEarnWithdrawal(txId: string, deps: ResumeDeps = {}): Promise<void> {
  const row = await Repo.transactions.where({ id: txId }).first();
  if (!row || row.type !== 'earn-withdraw') return;
  const ei: IEarnWithdrawExtraInputs = row.extraInputs;
  if (!NON_TERMINAL_WITHDRAW_PHASES.has(ei.phase)) return;

  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  const registerBridgeIn = deps.registerBridgeIn ?? registerPendingBridgeIn;
  const startDeliveryPoll = deps.startDeliveryPoll ?? pollEarnWithdrawDelivery;
  const findBridgeIn = deps.findBridgeIn ?? findPendingBridgeInByEarnWithdrawTxId;

  let nonce = ei.withdrawIntentNonce;
  // The row can lose its nonce if the process was torn down between the two post-submit
  // writes (bridge-in registry FIRST, then the row-nonce). The registry entry proves the
  // intent was submitted, so recover the nonce from it and re-persist rather than falsely
  // failing a live withdrawal.
  if (!nonce) {
    const pending = await findBridgeIn(txId).catch((err: unknown) => {
      console.warn('[earn-withdraw] resume bridge-in lookup failed', err);
      return undefined;
    });
    if (pending?.intentNonce) {
      nonce = pending.intentNonce;
      await updatePhase(txId, 'redeeming', { withdrawIntentNonce: nonce }).catch((err: unknown) =>
        console.warn('[earn-withdraw] resume nonce re-persist failed', err)
      );
    }
  }

  if (!nonce || !isEvmAddress(ei.evmOwner)) {
    await updatePhase(txId, 'failed', { error: 'Withdrawal was interrupted before it was submitted.' });
    return;
  }

  // Re-register is idempotent (per-nonce dedup) and restarts the delivery poll.
  await registerBridgeIn(ei.evmOwner, nonce, {
    provider: 'epoch',
    sourceAmount: ei.sourceAmount,
    sourceSymbol: ei.sourceSymbol,
    intentNonce: nonce,
    earnWithdrawTxId: txId
  });
  startDeliveryPoll({ sponsorAddress: ei.evmOwner, nonce, txId, deps });
}

/**
 * Scan for `earn-withdraw` rows left non-terminal by an app kill and resume or fail
 * them. Called once per session on the Explore mount (post-unlock). Rows older than
 * the 7-day TTL are failed outright.
 */
export async function reconcileEarnWithdrawals(deps: ResumeDeps = {}): Promise<void> {
  // `type` is not a Dexie index (see repo.ts), so scan + filter rather than
  // `.where('type')` (which throws SchemaError).
  const rows = await Repo.transactions.filter(tx => tx.type === 'earn-withdraw').toArray();
  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  const cutoffSec = Math.floor((Date.now() - WITHDRAW_STALE_MS) / 1000);

  for (const row of rows) {
    if (row.type !== 'earn-withdraw') continue;
    // Optional-chained: a row with no `extraInputs` has no phase to advance, and
    // throwing here would stall every row behind it in the loop.
    const ei: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
    if (!NON_TERMINAL_WITHDRAW_PHASES.has(ei?.phase ?? '')) continue;
    if (row.initiatedAt < cutoffSec) {
      await updatePhase(row.id, 'failed', { error: 'Withdrawal timed out.' }).catch(() => undefined);
      continue;
    }
    await resumeEarnWithdrawal(row.id, deps).catch((err: unknown) =>
      console.warn('[earn-withdraw] reconcile resume failed', err)
    );
  }
}

type ResubmitDeps = GaslessEarnWithdrawalDeps;

/**
 * Retry a terminally-failed Smart Withdraw by submitting a BRAND NEW Epoch intent.
 *
 * Re-polling the old nonce is pointless: `phase === 'failed'` means Epoch already
 * reported that intent as failed/expired, so it will report the same forever. The
 * position, however, was never redeemed, and `IEarnWithdrawExtraInputs` persists
 * everything `gaslessEarnWithdrawalToMiden` needs to rebuild the request —
 * `evmOwner` (sponsor), `marketUid`, `sourceAmount`, `sourceSymbol` — with the
 * Miden destination on `row.accountId` and the underlying pinned to
 * `EARN_UNDERLYING` (the gasless path only supports that market anyway). So this
 * runs the whole flow again and gets a fresh nonce.
 *
 * The SAME row is reused (via the `initiateRow` dep) so history keeps one entry per
 * withdrawal instead of accreting a row per retry. Its phase is reset to `redeeming`
 * with a direct `modify` — `updateEarnWithdrawPhase` is intentionally monotonic and
 * would refuse to move a terminal `failed` row backwards; this explicit,
 * user-initiated reset is the one sanctioned exception.
 *
 * Caveat: if the previous intent failed AFTER the Sepolia redeem leg landed, there
 * is nothing left in the market to withdraw and the resubmitted intent will fail
 * again — safely, by marking the row `failed` a second time.
 */
export async function resubmitEarnWithdrawal(txId: string, deps: ResubmitDeps = {}): Promise<void> {
  const row = await Repo.transactions.where({ id: txId }).first();
  if (!row || row.type !== 'earn-withdraw') throw new Error(`Transaction ${txId} is not an earn-withdraw`);
  const ei: IEarnWithdrawExtraInputs = row.extraInputs;
  if (ei.phase !== 'failed') return;
  if (!isEvmAddress(ei.evmOwner)) {
    throw new Error('This withdrawal has no valid position owner recorded — start a new withdrawal.');
  }
  if (!ei.marketUid || !ei.sourceAmount) {
    throw new Error('This withdrawal is missing the market details needed to retry — start a new withdrawal.');
  }

  // Clear the terminal state (and the dead nonce) so the reused row is live again.
  await Repo.transactions.where({ id: txId }).modify(dbTx => {
    const inputs: IEarnWithdrawExtraInputs = dbTx.extraInputs;
    dbTx.extraInputs = { ...inputs, phase: 'redeeming', error: undefined, withdrawIntentNonce: undefined };
    dbTx.error = undefined;
  });

  await gaslessEarnWithdrawalToMiden(
    {
      midenAccountPublicKey: row.accountId,
      evmAddress: ei.evmOwner,
      marketUid: ei.marketUid,
      underlyingAddress: EARN_UNDERLYING,
      amount: ei.sourceAmount,
      underlyingDecimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS
    },
    { ...deps, initiateRow: deps.initiateRow ?? (async () => txId) }
  );
}
