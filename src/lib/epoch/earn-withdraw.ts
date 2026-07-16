import { EpochIntentSDK, TaskType, ActionType } from '@epoch-protocol/epoch-intents-sdk';
import { type Address, parseUnits } from 'viem';
import { sepolia } from 'viem/chains';

import {
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
import { EARN_PROTOCOL_HASH, EARN_UNDERLYING, EARN_DONE_STATUSES, EARN_FAILED_STATUSES } from './earn';
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

function asAddress(value: string, label: string): Address {
  if (!EVM_ADDRESS_RE.test(value)) throw new Error(`${label} is not a valid EVM address.`);
  return value as Address;
}

function isEvmAddress(value: string): value is `0x${string}` {
  return EVM_ADDRESS_RE.test(value);
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
 * Any failure after the row exists marks it `failed` before rethrowing.
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
    const nonceString = String(nonce);

    await updatePhase(txId, 'redeeming', { withdrawIntentNonce: nonceString });
    await registerBridgeIn(sponsorAddress, nonceString, {
      provider: 'epoch',
      sourceAmount: args.amount,
      sourceSymbol: 'USDC',
      intentNonce: nonceString,
      earnWithdrawTxId: txId
    });

    startDeliveryPoll({ sponsorAddress, nonce: nonceString, txId });

    return { txId, nonce: nonceString, gaslessUsed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updatePhase(txId, 'failed', { error: message }).catch((err: unknown) =>
      console.warn('[earn-withdraw] failed-phase patch failed', err)
    );
    throw error;
  }
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
    try {
      if (!isEvmAddress(sponsorAddress)) {
        clearInterval(interval);
        return;
      }
      const sdk = await getSdk(sponsorAddress);
      const results = await sdk.getIntentStatus(sponsorAddress, nonce);
      const statuses = results.map(s => (s.status ?? '').toLowerCase());
      const done = statuses.some(s => EARN_DONE_STATUSES.has(s));
      const failed = !done && statuses.some(s => EARN_FAILED_STATUSES.has(s));

      // Learn the bridged note id as soon as it appears so an already-completed
      // consume row (delivery-before-poll race) gets tagged + flipped to received.
      const midenNoteId = extractMidenNoteId(results);
      if (midenNoteId) await resolveNoteId(nonce, midenNoteId).catch(() => undefined);

      if (done || failed) {
        clearInterval(interval);
        const fill = results[results.length - 1];
        const evmTxHash = fill?.transactionHash || undefined;
        if (done) {
          await updatePhase(txId, 'delivering', evmTxHash ? { evmTxHash } : undefined);
        } else {
          await updatePhase(txId, 'failed', { error: 'The withdrawal intent failed on Epoch.' });
        }
      }
    } catch (err) {
      console.warn('[earn-withdraw] delivery poll failed', err);
    }
    if (attempts >= maxAttempts) clearInterval(interval);
  }
}

interface ResumeDeps extends DeliveryPollDeps {
  registerBridgeIn?: typeof registerPendingBridgeIn;
  startDeliveryPoll?: typeof pollEarnWithdrawDelivery;
}

/**
 * Idempotently resume a non-terminal `earn-withdraw` row after an app restart.
 * If the redeem intent was submitted (`withdrawIntentNonce` recorded), the bridge-in
 * is re-registered and delivery polling restarts. If it was never submitted (app
 * killed mid-solve), the row is marked `failed` — the EVM intent can't be safely
 * reconstructed. No-op on terminal rows.
 */
export async function resumeEarnWithdrawal(txId: string, deps: ResumeDeps = {}): Promise<void> {
  const row = await Repo.transactions.where({ id: txId }).first();
  if (!row || row.type !== 'earn-withdraw') return;
  const ei = row.extraInputs as IEarnWithdrawExtraInputs;
  if (!NON_TERMINAL_WITHDRAW_PHASES.has(ei.phase)) return;

  const updatePhase = deps.updatePhase ?? updateEarnWithdrawPhase;
  const registerBridgeIn = deps.registerBridgeIn ?? registerPendingBridgeIn;
  const startDeliveryPoll = deps.startDeliveryPoll ?? pollEarnWithdrawDelivery;

  const nonce = ei.withdrawIntentNonce;
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
    const ei = row.extraInputs as IEarnWithdrawExtraInputs;
    if (!NON_TERMINAL_WITHDRAW_PHASES.has(ei.phase)) continue;
    if (row.initiatedAt < cutoffSec) {
      await updatePhase(row.id, 'failed', { error: 'Withdrawal timed out.' }).catch(() => undefined);
      continue;
    }
    await resumeEarnWithdrawal(row.id, deps).catch((err: unknown) =>
      console.warn('[earn-withdraw] reconcile resume failed', err)
    );
  }
}
