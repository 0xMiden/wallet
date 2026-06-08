import { CollateralType } from '@epoch-protocol/epoch-intents-sdk';
import { formatUnits } from 'viem';

import { updateBridgeClaimStatus } from 'lib/miden/activity';

import { buildCrossChainIntent, getCrossChainQuote } from './bridge';
import {
  BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL,
  EPOCH_DESTINATION_CHAIN_ID,
  isBridgeableEvmTokenConfigured
} from './bridgeable-token';
import { getCurrentMidenBlock, MIDEN_MIN_RECLAIM_BLOCKS } from './chain';
import { createBridgeP2IDNote, type BridgeNoteDeps } from './miden-note';
import { getEpochReadOnlySdk } from './sdk';
import type { CrossChainIntentParams } from './types';

export interface EpochQuoteOutput {
  /** Estimated EVM output, human-formatted (18 decimals). */
  amount: string;
  /** Output token symbol (USDC). */
  symbol: string;
}

/** Format an Epoch quote amount (base units or already-human decimal) to a human string. */
function formatQuoteAmount(raw: string, decimals: number): string {
  if (!raw || raw === '0') return '0';
  try {
    if (/^\d+\.\d+$/.test(raw)) return raw; // already a human decimal
    return formatUnits(BigInt(raw), decimals);
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
    midenReclaimHeight: currentBlock + MIDEN_MIN_RECLAIM_BLOCKS
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
}

/**
 * Fast (Epoch) Miden → EVM send. Needs only the destination address — the EVM leg
 * is solver-fulfilled against a Miden-side P2IDE note, so the user signs nothing on
 * EVM and no wallet connection is required. Drives the SDK directly (read-only
 * client) rather than the wallet-bound store.
 *
 * There is exactly ONE on-chain transaction: the recallable P2IDE note created by
 * the `createMidenP2IDNote` callback (`createBridgeP2IDNote`). That note IS the
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

  // Forward quote (input → output), then solve. `createMidenP2IDNote` blocks until
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
    createMidenP2IDNote: async (faucet, amount, allocatorId) => {
      const res = await createBridgeP2IDNote({
        senderAccountId: args.senderPublicKey,
        faucetId: faucet,
        amount,
        allocatorId,
        destinationAddress: args.destinationAddress,
        destinationNetwork: EPOCH_DESTINATION_CHAIN_ID,
        deps: args.deps
      });
      bridgeTxId = res.txId;
      return { success: res.success, noteId: res.noteId };
    }
  });
  if (intent.error) {
    throw new Error(intent.error);
  }

  // Record the solver/intent hash (informational). `updateBridgeClaimStatus`
  // mutates extraInputs only, so it's fine that the row is already Completed.
  const evmTxHash = intent.solveResult?.hash;
  if (bridgeTxId && evmTxHash) {
    await updateBridgeClaimStatus(bridgeTxId, 'not-applicable', { evmTxHash });
  }
  return { txId: bridgeTxId };
}
