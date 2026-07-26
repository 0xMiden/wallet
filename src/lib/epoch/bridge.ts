import {
  CollateralType,
  EpochIntentSDK,
  GetTaskDataParams,
  IntentQuoteResult,
  SolveIntentParams,
  TaskType
} from '@epoch-protocol/epoch-intents-sdk';
import { AccountId, Address } from '@miden-sdk/miden-sdk';
import { formatUnits, parseUnits } from 'viem';

import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import type { CrossChainIntentParams, EVMToMidenIntentParams, IntentResult } from './types';

export interface CrossChainQuote {
  taskTypeString: string;
  intentData: unknown;
  quoteResult: IntentQuoteResult;
  params: CrossChainIntentParams;
}

/** Pre-fetched EVM->Miden quote for the typed EVM input amount. */
export interface EVMToMidenQuote {
  taskTypeString: string;
  intentData: unknown;
  quoteResult: IntentQuoteResult;
  params: EVMToMidenIntentParams;
}

/** Format base-unit token amount for display. */
export function formatQuoteTokenIn(raw: string | undefined, tokenDecimals: number): string {
  if (!raw || raw === '0') return 'calculated at execution';
  try {
    // If backend ever returns a human-readable decimal string, normalize it.
    // IMPORTANT: integer strings (e.g. "1099993") are base units and must use
    // formatUnits(BigInt(...), dec), not parseUnits(...), otherwise decimals are lost.
    if (/^\d+\.\d+$/.test(raw)) {
      return formatUnits(parseUnits(raw, tokenDecimals), tokenDecimals);
    }

    return formatUnits(BigInt(raw), tokenDecimals);
  } catch {
    return raw;
  }
}

/**
 * Cross-chain bridge architecture using P2ID notes:
 *
 * 1. User creates a P2ID note on Miden targeting the trusted allocator service
 * 2. The allocator service (holding the P2ID note) builds an Epoch intent via SIO
 * 3. SIO solver fulfills the intent on the destination EVM chain
 * 4. On successful execution, the allocator consumes the P2ID note (claiming the Miden funds)
 * 5. If the intent fails/expires, the P2ID note can be recalled by the user
 *
 * This keeps funds locked in a P2ID note (not custodied) until the cross-chain
 * intent is fulfilled — privacy-preserving on the Miden side, trustless on EVM side.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

export function normalizeMidenIdToHex(id: string): string {
  const raw = (id ?? '').trim();
  if (!raw) return raw;

  // Already hex.
  if (raw.startsWith('0x') || raw.startsWith('0X')) {
    try {
      return AccountId.fromHex(raw).toString();
    } catch {
      return raw;
    }
  }

  // Plain hex without 0x.
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    try {
      return AccountId.fromHex(`0x${raw}`).toString();
    } catch {
      return raw;
    }
  }

  // Bech32 (address or account). Wallet adapter often returns `mtst..._...`.
  try {
    if (raw.includes('_')) {
      return Address.fromBech32(raw).accountId().toString();
    }
  } catch {
    // fallthrough
  }

  try {
    return AccountId.fromBech32(raw).toString();
  } catch {
    return raw;
  }
}

export function buildEpochTaskDataParams(params: CrossChainIntentParams): GetTaskDataParams {
  if (params.midenReclaimHeight == null || params.midenReclaimHeight <= 0) {
    throw new Error(
      'Miden→EVM: midenReclaimHeight is required and must be an ABSOLUTE future Miden block ' +
        '(currentMidenBlock + delta, delta ≥ 1000). A stale value makes the P2IDE note reclaimable ' +
        'at creation and the intent will fail.'
    );
  }

  const midenSourceAccountHex = normalizeMidenIdToHex(params.midenAccountId);
  const midenFaucetIdHex = normalizeMidenIdToHex(params.midenFaucetId);

  const outputToken = params.outputTokenAddress || ZERO_ADDRESS;

  // midenAmount and minTokenOut are both base units. "0" / empty → reverse-quote route.
  const tokenInAmount = (params.midenAmount ?? '').trim() || '0';
  const scaledMinTokenOut = (params.minTokenOut ?? '').trim() || '0';

  const taskDataParams = {
    taskType: 'gettokenout' as TaskType,
    intentData: {
      // isNative must be false — tokenIn is zero-address (Miden-sourced) but tokenOut is a real EVM token
      isNative: false,
      depositTokenAddress: ZERO_ADDRESS,
      tokenInAmount,
      outputTokenAddress: outputToken,
      minTokenOut: scaledMinTokenOut,
      destinationChainId: String(params.destinationChainId),
      protocolHashIdentifier: ZERO_HASH,
      recipient: params.evmRecipient
    },
    // Mirror EpochSwapWidget Miden extraData pattern exactly
    extraDataTypestring:
      'string midenSourceAccount,string midenFaucetId,string midenNoteType,string midenNoteId,uint256 midenReclaimHeight',
    extraData: {
      midenSourceAccount: midenSourceAccountHex,
      midenFaucetId: midenFaucetIdHex,
      midenNoteType: 'P2IDE',
      midenNoteId: '',
      midenReclaimHeight: String(params.midenReclaimHeight)
    }
  };

  return taskDataParams;
}

export function buildEVMToMidenTaskDataParams(params: EVMToMidenIntentParams) {
  const midenRecipientHex = normalizeMidenIdToHex(params.midenRecipientId);
  const midenFaucetHex = normalizeMidenIdToHex(params.midenFaucetId);
  const evmDecimals = params.evmTokenDecimals ?? 18;

  const rawEvm = params.evmAmount?.trim() ?? '';
  const hasFixedEvmIn = rawEvm !== '' && rawEvm !== '0';

  const minHuman = (params.minTokenOut ?? '').trim();
  // Do not scale using frontend-provided decimals. Treat minTokenOut as already
  // being in base units, and let backend derive/validate decimals from faucet id.
  const scaledMinMidenOut = minHuman ? minHuman : '0';

  const amountInWei = hasFixedEvmIn ? parseUnits(rawEvm, evmDecimals).toString() : '0';

  if (!hasFixedEvmIn && scaledMinMidenOut === '0') {
    throw new Error(
      'EVM→Miden: set minTokenOut (minimum Miden tokens to receive) for quote path, or provide evmAmount for a fixed EVM spend.'
    );
  }

  const destinationChainId = params.destinationChainId ?? MIDEN_DESTINATION_CHAIN_ID;
  if (destinationChainId !== MIDEN_DESTINATION_CHAIN_ID) {
    throw new Error(
      `EVM→Miden: destinationChainId must be ${MIDEN_DESTINATION_CHAIN_ID} (Miden output). Got ${destinationChainId}.`
    );
  }

  const taskDataParams = {
    taskType: TaskType.GetTokenOut,
    intentData: {
      isNative: false,
      depositTokenAddress: params.evmTokenAddress,
      tokenInAmount: amountInWei,
      outputTokenAddress: ZERO_ADDRESS,
      minTokenOut: scaledMinMidenOut, // Miden-side minimum out (base units)
      destinationChainId: String(destinationChainId),
      protocolHashIdentifier: ZERO_HASH,
      recipient: params.evmSourceAddress
    },
    extraDataTypestring: 'string midenRecipientAccount,string midenFaucetId,string midenNoteType',
    extraData: {
      midenRecipientAccount: midenRecipientHex,
      midenFaucetId: midenFaucetHex,
      midenNoteType: 'P2ID'
    }
  };

  return taskDataParams;
}

/** Step 1: quote EVM->Miden using the provided EVM input amount. */
export async function getEVMToMidenQuote(
  sdk: EpochIntentSDK,
  params: EVMToMidenIntentParams,
  sponsorAddress: string
): Promise<EVMToMidenQuote> {
  const taskDataParams = buildEVMToMidenTaskDataParams(params);
  const { taskTypeString, intentData } = await sdk.getTaskData(taskDataParams);

  const quoteResult = await sdk.getIntentQuote({
    sponsorAddress: sponsorAddress as `0x${string}`,
    taskTypeString,
    intentData,
    isNative: false
  });

  if (!quoteResult.success) {
    throw new Error(quoteResult.error ?? 'Quote failed');
  }

  return { taskTypeString, intentData, quoteResult, params };
}

export async function buildEVMToMidenIntent(
  sdk: EpochIntentSDK,
  params: EVMToMidenIntentParams & { preFetchedQuote?: EVMToMidenQuote }
): Promise<IntentResult> {
  let taskTypeString: string;
  let intentData: unknown;
  let quoteResult: IntentQuoteResult | undefined;

  if (params.preFetchedQuote) {
    ({ taskTypeString, intentData, quoteResult } = params.preFetchedQuote);
  } else {
    const taskDataParams = buildEVMToMidenTaskDataParams(params);
    ({ taskTypeString, intentData } = await sdk.getTaskData(taskDataParams));
  }

  try {
    const solveResult = await sdk.solveIntent({
      isNative: false,
      sponsorAddress: params.evmSourceAddress as `0x${string}`,
      taskTypeString,
      intentData,
      quoteResult,
      collateralType: 'evm' as CollateralType
    });

    return {
      taskTypeString,
      intentData: intentData as Record<string, unknown>,
      solveResult
    };
  } catch (err) {
    console.error('[EpochBridge] EVM→Miden solveIntent failed:', err);
    return {
      taskTypeString,
      intentData: intentData as Record<string, unknown>,
      error: err instanceof Error ? err.message : 'Failed to solve EVM→Miden intent'
    };
  }
}

/**
 * Get a cross-chain quote without executing. Forward route when `params.midenAmount`
 * is set (compute `tokenOut` from the given Miden input); reverse route when it's
 * absent/"0" (backend derives the required input from `minTokenOut`).
 * `buildEpochTaskDataParams` defaults `tokenInAmount` to "0", so omitting
 * `midenAmount` keeps the reverse behaviour for callers that rely on it.
 */
export async function getCrossChainQuote(
  sdk: EpochIntentSDK,
  params: CrossChainIntentParams,
  sponsorAddress: string
): Promise<CrossChainQuote> {
  const taskDataParams = buildEpochTaskDataParams(params);
  const { taskTypeString, intentData } = await sdk.getTaskData(taskDataParams);

  const quoteResult = await sdk.getIntentQuote({
    sponsorAddress: sponsorAddress as `0x${string}`,
    taskTypeString,
    intentData,
    isNative: false
  });

  if (!quoteResult.success) {
    throw new Error(quoteResult.error ?? 'Quote failed');
  }

  return { taskTypeString, intentData, quoteResult, params };
}

export async function buildCrossChainIntent(
  sdk: EpochIntentSDK,
  params: CrossChainIntentParams & {
    collateralType?: CollateralType;
    midenSourceAccount?: string;
    createMidenP2IDNote?: SolveIntentParams['createMidenP2IDNote'];
    /** Pre-fetched quote from getCrossChainQuote — skips getTaskData step. */
    preFetchedQuote?: CrossChainQuote;
  }
): Promise<IntentResult> {
  const midenFaucetIdHex = normalizeMidenIdToHex(params.midenFaucetId);
  const midenSourceHex = normalizeMidenIdToHex(params.midenSourceAccount || params.midenAccountId);
  let taskTypeString: string;
  let intentData: unknown;
  let quoteResult: IntentQuoteResult | undefined;

  if (params.preFetchedQuote) {
    ({ taskTypeString, intentData, quoteResult } = params.preFetchedQuote);
  } else {
    const taskDataParams = buildEpochTaskDataParams(params);
    ({ taskTypeString, intentData } = await sdk.getTaskData(taskDataParams));
  }

  try {
    const solveResult = await sdk.solveIntent({
      isNative: false,
      sponsorAddress: params.evmRecipient as `0x${string}`,
      taskTypeString,
      intentData,
      quoteResult,
      collateralType: (params.collateralType ?? 'miden') as CollateralType,
      midenFaucetId: midenFaucetIdHex,
      midenSourceAccount: midenSourceHex,
      createMidenP2IDNote: params.createMidenP2IDNote
    });

    return {
      taskTypeString,
      intentData: intentData as Record<string, unknown>,
      solveResult // Include the full execution result
    };
  } catch (err) {
    console.error('[EpochBridge] solveIntent failed:', err);
    // Still return the task data even if solve fails
    return {
      taskTypeString,
      intentData: intentData as Record<string, unknown>,
      error: err instanceof Error ? err.message : 'Failed to solve intent'
    };
  }
}
