import {
  CollateralType,
  EpochIntentSDK,
  IntentQuoteResult,
  SolveIntentParams,
  TaskType
} from '@epoch-protocol/epoch-intents-sdk';
import { keccak256, toBytes } from 'viem';

import { updateEarnDepositStatus } from 'lib/miden/activity';
import { type IEarnDepositExtraInputs, ITransactionStatus } from 'lib/miden/db/types';
import { isGuardianAccount } from 'lib/miden/front/guardian-manager';
import * as Repo from 'lib/miden/repo';

import { normalizeMidenIdToHex } from './bridge';
import { getCurrentMidenBlock, MIDEN_MIN_RECLAIM_BLOCKS, MIDEN_RECLAIM_BUFFER_BLOCKS } from './chain';
import { createEarnP2IDNote } from './earn-note';
import type { BridgeNoteDeps } from './miden-note';
import { getEpochReadOnlySdk } from './sdk';
import type { IntentResult } from './types';

/**
 * Epoch "Earn" — open a lending position by depositing Miden-held USDC into a
 * protocol market. Structurally this is the Miden→EVM `bridgeEpochSend` flow:
 * collateral is `CollateralType.Miden` (a recallable P2IDE note to the solver's
 * allocator), the EVM lending leg is solver-fulfilled, and the typed EVM address
 * is the position owner / intent sponsor — so NO connected EVM wallet is needed
 * (read-only SDK). The earn-specific bits are `TaskType.ProtocolInteraction`, the
 * `marketUid`/`action`/`payAsset` extraData, and a non-zero `protocolHashIdentifier`.
 */

// Miden-side collateral token (the wallet's USDC faucet) and its decimals.
export const MIDEN_USDC_FAUCET = '0x2458e5446128e6b150b75b8ebd9ce1';
export const MIDEN_USDC_DECIMALS = 6;

// E2E-only collateral-faucet override. The fixed `MIDEN_USDC_FAUCET` testnet id
// can't exist on a local e2e node, and the CLI-minted faucet id is only known at
// test time — so the harness injects it at runtime via `setEarnCollateralFaucetForTest`
// (mirrors `setAgglayerSenderForE2E`). Unset in production, so `getEarnCollateralFaucet()`
// returns `MIDEN_USDC_FAUCET` and behavior is byte-identical.
let earnCollateralFaucetOverride: string | undefined;

export function setEarnCollateralFaucetForTest(faucetHex: string | undefined): void {
  earnCollateralFaucetOverride = faucetHex;
}

function getEarnCollateralFaucet(): string {
  return earnCollateralFaucetOverride ?? MIDEN_USDC_FAUCET;
}

// Lending market the deposit targets (testnet `DUMMY_LENDING`). `EARN_UNDERLYING`
// matches `BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS` (Sepolia USDC).
export const EARN_MARKET_UID = 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
export const EARN_UNDERLYING = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
export const EARN_DESTINATION_CHAIN_ID = 11155111;
export const EARN_PROTOCOL_HASH = keccak256(toBytes('dummy-lending'));

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface EarnIntentParams {
  /** Sender's Miden account (bech32 or hex). */
  midenSourceAccount: string;
  /** Miden faucet of the collateral token. */
  midenFaucetId: string;
  /** Collateral amount in faucet base units (`MIDEN_USDC_DECIMALS`), as a string. */
  depositAmount: string;
  /** 0x EVM address that owns the resulting lending position (intent sponsor). */
  evmRecipient: `0x${string}`;
  /** Absolute future Miden block at which the P2IDE note becomes reclaimable. */
  midenReclaimHeight: number;
}

export interface EarnQuote {
  taskTypeString: string;
  intentData: Record<string, unknown>;
  quoteResult: IntentQuoteResult;
  params: EarnIntentParams;
}

/** Narrow a plain string to a 0x EVM address without a cast. */
function isEvmAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Build the Epoch `ProtocolInteraction` (lending deposit) mandate. Mirrors
 * `buildEpochTaskDataParams` but adds the market/action/payAsset extraData and a
 * non-zero `protocolHashIdentifier`, with `outputTokenAddress` = the market underlying.
 */
export function buildEarnTaskDataParams(params: EarnIntentParams) {
  const midenSourceHex = normalizeMidenIdToHex(params.midenSourceAccount);
  const midenFaucetHex = normalizeMidenIdToHex(params.midenFaucetId);

  return {
    taskType: TaskType.ProtocolInteraction,
    intentData: {
      isNative: false,
      depositTokenAddress: ZERO_ADDRESS,
      tokenInAmount: params.depositAmount,
      outputTokenAddress: EARN_UNDERLYING,
      minTokenOut: '0',
      destinationChainId: String(EARN_DESTINATION_CHAIN_ID),
      protocolHashIdentifier: EARN_PROTOCOL_HASH,
      recipient: params.evmRecipient
    },
    extraDataTypestring:
      'string marketUid,string action,string payAsset,uint256 midenReclaimHeight,' +
      'string midenSourceAccount,string midenFaucetId,string midenNoteType,string midenNoteId',
    extraData: {
      marketUid: EARN_MARKET_UID,
      action: 'deposit',
      payAsset: EARN_UNDERLYING,
      midenSourceAccount: midenSourceHex,
      midenFaucetId: midenFaucetHex,
      midenNoteType: 'P2IDE',
      midenNoteId: '',
      midenReclaimHeight: String(params.midenReclaimHeight)
    }
  };
}

/** Step 1: quote the lending deposit for the provided collateral amount. */
export async function getEarnQuote(
  sdk: EpochIntentSDK,
  params: EarnIntentParams,
  sponsorAddress: `0x${string}`
): Promise<EarnQuote> {
  const taskDataParams = buildEarnTaskDataParams(params);
  const { taskTypeString, intentData } = await sdk.getTaskData(taskDataParams);

  const quoteResult = await sdk.getIntentQuote({
    sponsorAddress,
    taskTypeString,
    intentData,
    isNative: false
  });
  if (!quoteResult.success) {
    throw new Error(quoteResult.error ?? 'Quote failed');
  }

  return { taskTypeString, intentData, quoteResult, params };
}

/** Step 2: submit the lending intent, locking Miden collateral via `createMidenP2IDNote`. */
export async function buildEarnIntent(
  sdk: EpochIntentSDK,
  params: EarnIntentParams & {
    createMidenP2IDNote?: SolveIntentParams['createMidenP2IDNote'];
    /** Pre-fetched quote from `getEarnQuote` — skips the getTaskData step. */
    preFetchedQuote?: EarnQuote;
    /**
     * Persist the intent nonce onto the activity row the instant it is known,
     * before this function returns. The collateral note is already on-chain and
     * the intent already submitted by the time `solveIntent` resolves, so waiting
     * to record the nonce until the caller resumes leaves a window where a
     * process teardown strands the row un-reconcilable (see the `reconcile` bail
     * on a missing `intentNonce`). Errors are the callback's responsibility.
     */
    persistIntentNonce?: (intentNonce: string) => Promise<void>;
  }
): Promise<IntentResult> {
  const midenFaucetHex = normalizeMidenIdToHex(params.midenFaucetId);
  const midenSourceHex = normalizeMidenIdToHex(params.midenSourceAccount);

  let taskTypeString: string;
  let intentData: Record<string, unknown>;
  let quoteResult: IntentQuoteResult | undefined;

  if (params.preFetchedQuote) {
    ({ taskTypeString, intentData, quoteResult } = params.preFetchedQuote);
  } else {
    const taskDataParams = buildEarnTaskDataParams(params);
    ({ taskTypeString, intentData } = await sdk.getTaskData(taskDataParams));
  }

  try {
    const solveResult = await sdk.solveIntent({
      isNative: false,
      sponsorAddress: params.evmRecipient,
      taskTypeString,
      intentData,
      quoteResult,
      collateralType: CollateralType.Miden,
      midenFaucetId: midenFaucetHex,
      midenSourceAccount: midenSourceHex,
      createMidenP2IDNote: params.createMidenP2IDNote
    });
    // The nonce lands on one of several fields depending on the solve path.
    const nonce =
      solveResult?.nonce ?? solveResult?.submittedIntentData?.nonce ?? solveResult?.allocationResponse?.nonce;
    const intentNonce = nonce != null ? String(nonce) : undefined;
    // Record the nonce before returning: the intent is already submitted, so a
    // torn-down process must still leave a row the reconciler can query. A
    // persistence failure must NOT be mistaken for a solve failure — the intent
    // has landed — so swallow it here rather than let it hit the catch below.
    if (intentNonce && params.persistIntentNonce) {
      await params
        .persistIntentNonce(intentNonce)
        .catch((err: unknown) => console.warn('[epoch] persistIntentNonce failed', err));
    }
    return { taskTypeString, intentData, solveResult, intentNonce };
  } catch (err) {
    console.error('[epoch] earn solveIntent failed:', err);
    return {
      taskTypeString,
      intentData,
      error: err instanceof Error ? err.message : 'Failed to open lending position'
    };
  }
}

// Epoch `getIntentStatus` terminal states for the lending leg.
export const EARN_DONE_STATUSES = new Set(['completed', 'finalized', 'success', 'filled', 'settled']);
export const EARN_FAILED_STATUSES = new Set(['failed', 'error', 'expired', 'reverted']);

/**
 * Minimal shape of one `getIntentStatus` entry. Epoch returns ONE entry per chain
 * leg of an intent (source + destination), so the SDK's `IntentTransactionStatus`
 * is structurally assignable to this.
 */
export interface EpochLegStatus {
  chainId?: number;
  status?: string;
  transactionHash?: string;
}

export type EarnIntentOutcome = 'pending' | 'done' | 'failed';

/**
 * Collapse Epoch's per-chain status entries into a single intent outcome.
 *
 * The gating is deliberately ASYMMETRIC, and this is the whole point of the
 * helper (mirrors `pollEpochIntentFill`'s destination-leg preference):
 *
 *  - `done` requires the DESTINATION leg (`destinationChainId`) to report a
 *    terminal success. A completed SOURCE leg only means the collateral was
 *    picked up — the deposit/delivery it pays for may still be pending or may
 *    yet fail, so it must never be read as success.
 *  - `failed` is decided by the destination leg first, but a terminal failure on
 *    ANY leg is also fatal: if the source leg reverted, the destination leg will
 *    never land, so there is nothing left to wait for.
 *  - everything else is `pending` (including "no destination entry yet").
 */
export function resolveEarnIntentOutcome(
  results: readonly EpochLegStatus[],
  destinationChainId: number
): { outcome: EarnIntentOutcome; destination?: EpochLegStatus; source?: EpochLegStatus } {
  const destination = results.find(entry => entry.chainId === destinationChainId);
  const source = results.find(entry => entry.chainId !== destinationChainId);
  const destinationStatus = (destination?.status ?? '').toLowerCase();

  if (EARN_DONE_STATUSES.has(destinationStatus)) return { outcome: 'done', destination, source };
  if (EARN_FAILED_STATUSES.has(destinationStatus)) return { outcome: 'failed', destination, source };
  if (results.some(entry => EARN_FAILED_STATUSES.has((entry.status ?? '').toLowerCase()))) {
    return { outcome: 'failed', destination, source };
  }
  return { outcome: 'pending', destination, source };
}

/**
 * Background-poll the Epoch allocator for a lending intent's fill and flip the
 * `earn-deposit` row's `epochStatus` once it settles. Fire-and-forget: the Miden
 * collateral note is already locked by the time this runs, so the form doesn't wait
 * on it — the activity row updates in place. Uses the read-only SDK (no wallet),
 * and self-terminates on a terminal status or after `maxAttempts` ticks.
 *
 * Settlement is gated on the SEPOLIA (destination) leg via
 * `resolveEarnIntentOutcome` — the Miden source leg completing only means the
 * collateral note was consumed by the allocator, not that the lending deposit
 * landed.
 */
export function pollEarnIntentStatus(args: {
  sponsorAddress: `0x${string}`;
  nonce: string;
  /** `earn-deposit` row id to patch when the intent settles. */
  txId?: string;
  intervalMs?: number;
  maxAttempts?: number;
}): void {
  const { sponsorAddress, nonce, txId, intervalMs = 3000, maxAttempts = 100 } = args;
  let attempts = 0;
  const interval = setInterval(() => void tick(), intervalMs);

  async function tick(): Promise<void> {
    attempts += 1;
    try {
      const sdk = await getEpochReadOnlySdk(sponsorAddress);
      const results = await sdk.getIntentStatus(sponsorAddress, nonce);
      console.log('[earn] poll intent status', results);
      const { outcome, destination, source } = resolveEarnIntentOutcome(results, EARN_DESTINATION_CHAIN_ID);
      if (outcome !== 'pending') {
        clearInterval(interval);
        // The Sepolia (destination) leg carries the EVM tx hash for the position;
        // on a source-side failure fall back to whatever leg reported.
        const evmTxHash = destination?.transactionHash || source?.transactionHash || undefined;
        if (txId) {
          await updateEarnDepositStatus(
            txId,
            outcome === 'done' ? 'confirmed' : 'failed',
            evmTxHash ? { evmTxHash } : undefined
          );
        }
      }
    } catch (err) {
      console.warn('[epoch] pollEarnIntentStatus failed', err);
    }
    if (attempts >= maxAttempts) clearInterval(interval);
  }
}

/**
 * Why Guardian (multisig) accounts cannot open Earn positions yet.
 *
 * The Epoch mandate advertises the collateral note as a **P2IDE with an absolute
 * `midenReclaimHeight`** (see `buildEarnTaskDataParams`) — that reclaim height is
 * both what the allocator validates and the user's only escape hatch if the
 * lending leg never settles. The Guardian proposal API
 * (`@openzeppelin/miden-multisig-client`) exposes only `createP2idProposal`
 * (recipient/faucet/amount — no reclaim height) plus the structural proposals and
 * `createCustomProposal(requestBytes)`; there is NO P2IDE / recall-height
 * proposal. Routing an earn deposit through `createSendProposal` therefore mints
 * a plain P2ID: the note does not match the mandate (the allocator can reject the
 * intent) and the collateral has no reclaim path.
 *
 * Rather than ship that silent mismatch, earn deposits are refused for Guardian
 * accounts here, at the earliest point that has a guardian provider (before any
 * quote or intent exists), and again in the Guardian branch of
 * `generateTransaction`. Lifting this needs a P2IDE-capable proposal (or a
 * hand-built P2IDE `requestBytes` fed through `createCustomProposal`, the way the
 * Agglayer `bridged-send` path does).
 */
export const GUARDIAN_EARN_DEPOSIT_UNSUPPORTED =
  'Earn deposits are not available on Guardian accounts yet — the collateral note needs a reclaim height ' +
  'that Guardian proposals cannot express. Use a standard account to deposit.';

export interface OpenEarnPositionArgs {
  /** Collateral amount in `MIDEN_USDC_DECIMALS` base units. */
  amount: bigint;
  /** 0x EVM address that will own the lending position. */
  evmAddress: string;
  /** Sender's Miden account (bech32). */
  senderPublicKey: string;
  deps: BridgeNoteDeps;
  /** Fired once the `earn-deposit` row is created (mid-solve, before it proves + submits). */
  onRowCreated?: (txId: string) => void;
}

/**
 * Open an Epoch lending position. Needs only the typed EVM address — the lending
 * deposit is solver-fulfilled against a Miden-side P2IDE collateral note, so the
 * user signs nothing on EVM and no wallet connection is required. Drives the SDK
 * directly via the read-only client.
 *
 * There is exactly ONE on-chain transaction: the recallable P2IDE note created by
 * the `createMidenP2IDNote` callback (`createEarnP2IDNote`). That note IS the
 * `earn-deposit` activity row — created, proved, and submitted by the normal send
 * pipeline, then marked "Deposited to lending".
 */
export async function openEarnPosition(args: OpenEarnPositionArgs): Promise<{ txId?: string }> {
  if (args.amount <= 0n) {
    throw new Error('Deposit amount must be greater than zero.');
  }
  if (!isEvmAddress(args.evmAddress)) {
    throw new Error('Enter a valid EVM address (0x followed by 40 hex characters).');
  }
  if (await isGuardianAccount(args.senderPublicKey, args.deps.guardianProvider)) {
    throw new Error(GUARDIAN_EARN_DEPOSIT_UNSUPPORTED);
  }
  const evmRecipient = args.evmAddress;

  const sdk = await getEpochReadOnlySdk(evmRecipient);
  const currentBlock = await getCurrentMidenBlock();

  const params: EarnIntentParams = {
    midenSourceAccount: args.senderPublicKey,
    midenFaucetId: getEarnCollateralFaucet(),
    depositAmount: args.amount.toString(),
    evmRecipient,
    // Minimum window + headroom for the blocks that elapse while the collateral
    // note is proved and submitted (the allocator validates against its later
    // chain head). Mirrors `buildEpochSendIntentParams`.
    midenReclaimHeight: currentBlock + MIDEN_MIN_RECLAIM_BLOCKS + MIDEN_RECLAIM_BUFFER_BLOCKS
  };

  let earnTxId: string | undefined;
  const quote = await getEarnQuote(sdk, params, evmRecipient);
  const intent = await buildEarnIntent(sdk, {
    ...params,
    preFetchedQuote: quote,
    // Persist the nonce onto the row the moment `solveIntent` yields it — before
    // control returns here — so a WebView teardown in that window still leaves a
    // reconcilable row. `earnTxId` is already set by then (the collateral-note
    // callback below runs during `solveIntent`).
    persistIntentNonce: async intentNonce => {
      if (!earnTxId) return;
      await updateEarnDepositStatus(earnTxId, 'pending', { intentNonce }).catch((err: unknown) =>
        console.warn('[epoch] updateEarnDepositStatus(pending) failed', err)
      );
    },
    createMidenP2IDNote: async (faucet, amount, allocatorId) => {
      const res = await createEarnP2IDNote({
        senderAccountId: args.senderPublicKey,
        faucetId: faucet,
        amount,
        allocatorId,
        evmRecipient,
        marketUid: EARN_MARKET_UID,
        deps: args.deps,
        onRowCreated: args.onRowCreated
      });
      earnTxId = res.txId;
      return { success: res.success, noteId: res.noteId };
    }
  });

  if (intent.error) {
    if (earnTxId) {
      await updateEarnDepositStatus(earnTxId, 'failed').catch((err: unknown) =>
        console.warn('[epoch] updateEarnDepositStatus(failed) failed', err)
      );
    }
    throw new Error(intent.error);
  }

  if (!earnTxId) {
    throw new Error('Epoch did not request the Miden collateral note.');
  }

  if (earnTxId && !intent.intentNonce) {
    await updateEarnDepositStatus(earnTxId, 'failed').catch((err: unknown) =>
      console.warn('[epoch] updateEarnDepositStatus(failed) failed', err)
    );
    throw new Error('Epoch accepted the collateral note but did not return an intent nonce.');
  }

  // The intent nonce was already persisted inside `buildEarnIntent`
  // (`persistIntentNonce`) the instant it was known. Here we only kick off the
  // background poll that flips `epochStatus` pending → confirmed/failed.
  if (earnTxId && intent.intentNonce) {
    pollEarnIntentStatus({ sponsorAddress: evmRecipient, nonce: intent.intentNonce, txId: earnTxId });
  }

  return { txId: earnTxId };
}

interface ReconcileEarnDepositsDeps {
  getSdk?: typeof getEpochReadOnlySdk;
  updateStatus?: typeof updateEarnDepositStatus;
  /** Injectable background poller (tests pass a no-op). */
  startStatusPoll?: typeof pollEarnIntentStatus;
}

/**
 * Startup reconciler for `earn-deposit` rows — the deposit-side counterpart of
 * `reconcileEarnWithdrawals`.
 *
 * `pollEarnIntentStatus` is a plain `setInterval` living in the popup / app
 * process: closing the popup (or an iOS WebView teardown) kills it mid-flight and
 * the row is stranded on `epochStatus: 'pending'` forever, even though the Epoch
 * intent has long since settled. This scans the Completed `earn-deposit` rows
 * that are still un-settled and re-polls their intents once, applying the same
 * destination-leg gating (`resolveEarnIntentOutcome`) the live poller uses. Rows
 * that are still genuinely in flight get their background poll restarted so they
 * settle within this session.
 *
 * Called once per session from the Explore mount, next to
 * `reconcileEarnWithdrawals`.
 */
export async function reconcileEarnDeposits(deps: ReconcileEarnDepositsDeps = {}): Promise<void> {
  const getSdk = deps.getSdk ?? getEpochReadOnlySdk;
  const updateStatus = deps.updateStatus ?? updateEarnDepositStatus;
  const startStatusPoll = deps.startStatusPoll ?? pollEarnIntentStatus;

  // `type` is not a Dexie index (see repo.ts), so scan + filter rather than
  // `.where('type')` (which throws SchemaError).
  const rows = await Repo.transactions.filter(tx => tx.type === 'earn-deposit').toArray();

  for (const row of rows) {
    // Only a row whose Miden collateral note actually landed has an intent to poll.
    if (row.status !== ITransactionStatus.Completed) continue;

    const inputs: IEarnDepositExtraInputs | undefined = row.extraInputs;
    if (!inputs) continue;
    // Already settled one way or the other — nothing to reconcile.
    if (inputs.epochStatus === 'confirmed' || inputs.epochStatus === 'failed') continue;
    if (!inputs.intentNonce || !isEvmAddress(inputs.evmRecipient)) continue;

    const sponsorAddress = inputs.evmRecipient;
    const nonce = inputs.intentNonce;
    try {
      const sdk = await getSdk(sponsorAddress);
      const results = await sdk.getIntentStatus(sponsorAddress, nonce);
      const { outcome, destination, source } = resolveEarnIntentOutcome(results, EARN_DESTINATION_CHAIN_ID);

      if (outcome === 'pending') {
        // Still in flight — restart the poller the dead process took with it.
        startStatusPoll({ sponsorAddress, nonce, txId: row.id });
        continue;
      }

      const evmTxHash = destination?.transactionHash || source?.transactionHash || undefined;
      await updateStatus(row.id, outcome === 'done' ? 'confirmed' : 'failed', evmTxHash ? { evmTxHash } : undefined);
    } catch (err) {
      console.warn('[earn] reconcile deposit failed', row.id, err);
    }
  }
}
