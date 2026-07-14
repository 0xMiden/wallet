import {
  CollateralType,
  EpochIntentSDK,
  IntentQuoteResult,
  SolveIntentParams,
  TaskType
} from '@epoch-protocol/epoch-intents-sdk';
import { keccak256, toBytes } from 'viem';

import { updateEarnDepositStatus } from 'lib/miden/activity';

import { normalizeMidenIdToHex } from './bridge';
import { getCurrentMidenBlock, MIDEN_MIN_RECLAIM_BLOCKS } from './chain';
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
      'string marketUid,string action,string payAsset,' +
      'string midenSourceAccount,string midenFaucetId,' +
      'string midenNoteType,string midenNoteId,uint256 midenReclaimHeight',
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
    return {
      taskTypeString,
      intentData,
      solveResult,
      intentNonce: nonce != null ? String(nonce) : undefined
    };
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
 * Background-poll the Epoch allocator for a lending intent's fill and flip the
 * `earn-deposit` row's `epochStatus` once it settles. Fire-and-forget: the Miden
 * collateral note is already locked by the time this runs, so the form doesn't wait
 * on it — the activity row updates in place. Uses the read-only SDK (no wallet),
 * and self-terminates on a terminal status or after `maxAttempts` ticks.
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
      const statuses = results.map(s => (s.status ?? '').toLowerCase());
      const done = statuses.some(s => EARN_DONE_STATUSES.has(s));
      const failed = !done && statuses.some(s => EARN_FAILED_STATUSES.has(s));
      if (done || failed) {
        clearInterval(interval);
        // The Sepolia (destination) leg carries the EVM tx hash for the position.
        const fill = results.find(r => r.chainId === EARN_DESTINATION_CHAIN_ID) ?? results[results.length - 1];
        const evmTxHash = fill?.transactionHash || undefined;
        if (txId) {
          await updateEarnDepositStatus(txId, done ? 'confirmed' : 'failed', evmTxHash ? { evmTxHash } : undefined);
        }
      }
    } catch (err) {
      console.warn('[epoch] pollEarnIntentStatus failed', err);
    }
    if (attempts >= maxAttempts) clearInterval(interval);
  }
}

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
  const evmRecipient = args.evmAddress;

  const sdk = await getEpochReadOnlySdk(evmRecipient);
  const currentBlock = await getCurrentMidenBlock();

  const params: EarnIntentParams = {
    midenSourceAccount: args.senderPublicKey,
    midenFaucetId: MIDEN_USDC_FAUCET,
    depositAmount: args.amount.toString(),
    evmRecipient,
    midenReclaimHeight: currentBlock + MIDEN_MIN_RECLAIM_BLOCKS
  };

  let earnTxId: string | undefined;
  const quote = await getEarnQuote(sdk, params, evmRecipient);
  const intent = await buildEarnIntent(sdk, {
    ...params,
    preFetchedQuote: quote,
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

  // Record the intent nonce on the row and poll the lending leg in the background;
  // the row's `epochStatus` flips pending → confirmed/failed as it settles.
  if (earnTxId && intent.intentNonce) {
    await updateEarnDepositStatus(earnTxId, 'pending', { intentNonce: intent.intentNonce }).catch((err: unknown) =>
      console.warn('[epoch] updateEarnDepositStatus(pending) failed', err)
    );
    pollEarnIntentStatus({ sponsorAddress: evmRecipient, nonce: intent.intentNonce, txId: earnTxId });
  }

  return { txId: earnTxId };
}
