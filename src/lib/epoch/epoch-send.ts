import { CollateralType } from '@epoch-protocol/epoch-intents-sdk';
import { formatUnits } from 'viem';

import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { markBridgedSendFailed, updateBridgeClaimStatus } from 'lib/miden/activity';

import { buildCrossChainIntent, getCrossChainQuote } from './bridge';
import {
  BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL,
  EPOCH_DESTINATION_CHAIN_ID,
  isBridgeableEvmTokenConfigured
} from './bridgeable-token';
import { getCurrentMidenBlock, MIDEN_MIN_RECLAIM_BLOCKS, MIDEN_RECLAIM_BUFFER_BLOCKS } from './chain';
import { createBridgeP2IDENote, type BridgeNoteDeps } from './miden-note';
import { getEpochReadOnlySdk } from './sdk';
import type { CrossChainIntentParams } from './types';

export interface EpochQuoteOutput {
  /** Estimated EVM output, human-formatted (18 decimals). */
  amount: string;
  /** Output token symbol (USDC). */
  symbol: string;
}

/**
 * Format an Epoch quote amount (18-decimal base units, or an already-human
 * decimal) to a display string with the standard 2-decimal precision, expanding
 * for small non-zero values that would otherwise appear as zero.
 */
function formatQuoteAmount(raw: string, decimals: number): string {
  if (!raw || raw === '0') return '0.00';
  try {
    const human = /^\d+\.\d+$/.test(raw) ? raw : formatUnits(BigInt(raw), decimals);
    return toAdaptiveFixed(human);
  } catch {
    return raw;
  }
}

/**
 * Shared forward-quote params for a Miden→EVM send. The `evmRecipient` doubles as
 * the intent sponsor (Miden collateral → solver-fulfilled EVM leg), so NO connected
 * EVM wallet is needed — only the destination address. `minTokenOut: '0'` = no
 * slippage floor (testnet); the backend computes the output from `midenAmount`.
 */
function buildEpochSendParams(
  amount: bigint,
  faucetId: string,
  destinationAddress: `0x${string}`,
  senderPublicKey: string,
  currentBlock: number
): CrossChainIntentParams {
  return {
    midenAccountId: senderPublicKey,
    midenFaucetId: faucetId,
    midenAmount: amount.toString(),
    evmRecipient: destinationAddress,
    destinationChainId: EPOCH_DESTINATION_CHAIN_ID,
    outputTokenAddress: BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
    outputTokenDecimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
    minTokenOut: '0',
    // Mandate-only estimate (hashed into the witness). The NOTE's actual reclaim
    // height uses the SDK-supplied `recallBlocks` from the mint callback instead;
    // the allocator validates the note's REMAINING window, not this exact height.
    midenReclaimHeight: currentBlock + MIDEN_MIN_RECLAIM_BLOCKS + MIDEN_RECLAIM_BUFFER_BLOCKS
  };
}

/**
 * Forward-quote the EVM output for a given Miden input WITHOUT executing. Backs
 * the send-flow Epoch tab's "you receive ~N USDC" preview. Uses the read-only SDK
 * (no connected EVM wallet) and never touches the store, so it can't disturb a
 * send in progress.
 */
export async function quoteEpochSendOutput(args: {
  amount: bigint;
  faucetId: string;
  destinationAddress: `0x${string}`;
  senderPublicKey: string;
}): Promise<EpochQuoteOutput> {
  if (!isBridgeableEvmTokenConfigured()) {
    throw new Error('The Fast (Epoch) route is not configured yet.');
  }
  const sdk = await getEpochReadOnlySdk(args.destinationAddress);
  const currentBlock = await getCurrentMidenBlock();
  const params = buildEpochSendParams(
    args.amount,
    args.faucetId,
    args.destinationAddress,
    args.senderPublicKey,
    currentBlock
  );
  const quote = await getCrossChainQuote(sdk, params, args.destinationAddress);

  const raw = quote.quoteResult.tokenOut != null ? String(quote.quoteResult.tokenOut) : '0';
  return {
    amount: formatQuoteAmount(raw, BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS),
    symbol: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL
  };
}

export interface EpochSendArgs {
  /** Base units of the Miden faucet token the user is sending. */
  amount: bigint;
  /** Miden faucet id of the token being bridged. Epoch accepts any token (hex or bech32). */
  faucetId: string;
  /** EVM recipient (0x) — also the intent sponsor; no connected wallet required. */
  destinationAddress: `0x${string}`;
  /** Sender's Miden account (bech32). */
  senderPublicKey: string;
  deps: BridgeNoteDeps;
  /**
   * Fired once the `bridged-send` row is created (mid-solve, before it proves +
   * submits). The send flow navigates to the generating-transaction screen with
   * this txId so it tracks the real row instead of racing an empty queue.
   */
  onRowCreated?: (txId: string) => void;
}

/**
 * Fast (Epoch) Miden → EVM send. Needs only the destination address — the EVM leg
 * is solver-fulfilled against a Miden-side P2IDE note, so the user signs nothing on
 * EVM and no wallet connection is required. Drives the SDK directly (read-only
 * client) rather than the wallet-bound store.
 *
 * There is exactly ONE on-chain transaction: the recallable P2IDE note created by
 * the `createMidenP2IDENote` callback (`createBridgeP2IDENote`). That note IS the
 * `bridged-send` activity row — created, proved, and submitted by the normal send
 * pipeline, then marked "Bridged to EVM" by `completeBridgedSendTransaction`.
 * bridgeEpochSend itself creates NO row; it only runs the quote → solve and patches
 * the row with the EVM solve hash afterwards. Epoch auto-settles on the destination
 * chain, so there is no manual claim (`claimStatus: 'not-applicable'`).
 */
export async function bridgeEpochSend(args: EpochSendArgs): Promise<{ txId?: string }> {
  if (!isBridgeableEvmTokenConfigured()) {
    throw new Error('The Fast (Epoch) route is not configured yet — missing the EVM output token address.');
  }

  const sdk = await getEpochReadOnlySdk(args.destinationAddress);
  const currentBlock = await getCurrentMidenBlock();
  const params = buildEpochSendParams(
    args.amount,
    args.faucetId,
    args.destinationAddress,
    args.senderPublicKey,
    currentBlock
  );

  // Forward quote (input → output), then solve. `createMidenP2IDENote` blocks until
  // the P2IDE `bridged-send` row is committed on Miden before the intent is
  // submitted. The sponsor is the recipient (set inside buildCrossChainIntent). We
  // capture the row id from the callback so we can patch the EVM solve hash on it.
  let bridgeTxId: string | undefined;
  const quote = await getCrossChainQuote(sdk, params, args.destinationAddress);
  const intent = await buildCrossChainIntent(sdk, {
    ...params,
    preFetchedQuote: quote,
    collateralType: CollateralType.Miden,
    midenSourceAccount: args.senderPublicKey,
    createMidenP2IDENote: async (faucet, amount, allocatorId, recallBlocks, bindingAttachmentFelts) => {
      const res = await createBridgeP2IDENote({
        senderAccountId: args.senderPublicKey,
        faucetId: faucet,
        amount,
        allocatorId,
        recallBlocks,
        bindingAttachmentFelts,
        destinationAddress: args.destinationAddress,
        destinationNetwork: EPOCH_DESTINATION_CHAIN_ID,
        deps: args.deps,
        onRowCreated: args.onRowCreated
      });
      bridgeTxId = res.txId;
      return { success: res.success, noteId: res.noteId };
    }
  });
  if (intent.error) {
    // The `createMidenP2IDENote` callback already committed the P2IDE note and the
    // send pipeline marked its `bridged-send` row Completed / 'Bridged to EVM'
    // BEFORE the allocator rejected the intent here. Demote that false success to
    // Failed so the user isn't told the bridge succeeded while their funds sit in
    // an unconsumed, recallable note.
    if (bridgeTxId) {
      await markBridgedSendFailed(bridgeTxId, intent.error, params.midenReclaimHeight);
    }
    throw new Error(intent.error);
  }

  // Persist the quote output + intent nonce so the activity view can render the
  // "you received N USDC" side and later poll `getIntentStatus` for the
  // receiving-chain fill. `updateBridgeClaimStatus` mutates extraInputs only, so
  // it's fine that the row is already Completed.
  const evmTxHash = intent.solveResult?.hash;
  const intentNonce = intent.intentNonce ?? intent.solveResult?.nonce;
  const rawTokenOut = quote.quoteResult.tokenOut != null ? String(quote.quoteResult.tokenOut) : '0';
  const outputAmount = formatQuoteAmount(rawTokenOut, BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS);
  if (bridgeTxId) {
    await updateBridgeClaimStatus(bridgeTxId, 'not-applicable', {
      evmTxHash,
      intentNonce,
      outputAmount,
      outputSymbol: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL,
      epochStatus: 'pending'
    });
  }
  return { txId: bridgeTxId };
}

export interface EpochIntentFill {
  /** Settlement status: `confirmed` once the destination fill completes, else `pending`/`failed`. */
  status: 'pending' | 'confirmed' | 'failed';
  /** Receiving-chain (destination EVM) settlement tx hash, when available. */
  fillTxHash?: string;
  /** Chain id the fill tx landed on. */
  fillChainId?: number;
}

const EPOCH_DONE_STATUSES = new Set(['completed', 'success', 'filled', 'settled']);
const EPOCH_FAILED_STATUSES = new Set(['failed', 'error', 'expired', 'reverted']);

/** Narrow a plain string to a 0x EVM address without an `as` cast. */
function isEvmAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Poll the Epoch allocator for the receiving-chain fill of a previously-submitted
 * Miden→EVM intent. `getIntentStatus` is a read-only allocator API call, so it
 * needs NO connected EVM wallet — the read-only SDK keyed on the destination
 * address suffices. Returns the destination-chain tx hash + a normalized status,
 * or `null` if nothing is queryable yet (no nonce, network error).
 *
 * The status array can carry entries for multiple chains; we prefer the entry on
 * the destination EVM chain (`EPOCH_DESTINATION_CHAIN_ID`), falling back to the
 * last entry. `confirmed` requires that entry to report a done status.
 */
export async function pollEpochIntentFill(args: {
  destinationAddress: string;
  intentNonce: string;
}): Promise<EpochIntentFill | null> {
  if (!args.intentNonce || !isEvmAddress(args.destinationAddress)) return null;
  try {
    const sdk = await getEpochReadOnlySdk(args.destinationAddress);
    const results = await sdk.getIntentStatus(args.destinationAddress, args.intentNonce);
    if (!results || results.length === 0) return { status: 'pending' };

    // Only the destination (Sepolia) leg decides the fill. Falling back to an
    // arbitrary last entry would let a done status on the Miden *source* leg flip
    // the row to Confirmed before the EVM leg settles — and surface a non-Sepolia
    // tx hash under a sepolia.etherscan.io link. When no destination entry exists
    // yet, stay pending.
    const onDest = results.find(r => r.chainId === EPOCH_DESTINATION_CHAIN_ID);
    if (!onDest) return { status: 'pending' };
    const normalized = (onDest.status ?? '').toLowerCase();

    let status: EpochIntentFill['status'] = 'pending';
    if (EPOCH_DONE_STATUSES.has(normalized)) status = 'confirmed';
    else if (EPOCH_FAILED_STATUSES.has(normalized)) status = 'failed';

    return {
      status,
      fillTxHash: onDest.transactionHash || undefined,
      fillChainId: onDest.chainId
    };
  } catch (err) {
    console.error('[epoch] pollEpochIntentFill failed', err);
    return null;
  }
}
