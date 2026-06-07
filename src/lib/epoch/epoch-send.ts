import { CollateralType } from '@epoch-protocol/epoch-intents-sdk';
import { formatUnits } from 'viem';

import {
  cancelTransactionById,
  initiateBridgedSendTransaction,
  updateBridgeClaimStatus,
  updateTransactionStatus
} from 'lib/miden/activity';
import { ITransactionStatus } from 'lib/miden/db/types';

import { getCrossChainQuote } from './bridge';
import {
  BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL,
  BRIDGEABLE_MIDEN_FAUCET_ID,
  EPOCH_DESTINATION_CHAIN_ID,
  isBridgeableEvmTokenConfigured
} from './bridgeable-token';
import { getCurrentMidenBlock, MIDEN_MIN_RECLAIM_BLOCKS } from './chain';
import { createBridgeP2IDNote, type BridgeNoteDeps } from './miden-note';
import { getEpochSdk } from './sdk';
import { useEpochStore } from './store';

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
 * Forward-quote the EVM output for a given Miden input WITHOUT executing. Backs
 * the send-flow Epoch tab's "you receive ~N USDC" preview. Calls the SDK quote
 * directly (not via the store) so it never disturbs the send-execution state.
 */
export async function quoteEpochSendOutput(args: {
  amount: bigint;
  destinationAddress: `0x${string}`;
  senderPublicKey: string;
  sponsorAddress: `0x${string}`;
}): Promise<EpochQuoteOutput> {
  if (!isBridgeableEvmTokenConfigured()) {
    throw new Error('The Fast (Epoch) route is not configured yet.');
  }
  const sdk = await getEpochSdk({ forMidenFlow: true });
  if (!sdk) throw new Error('Connect an EVM wallet first');

  const currentBlock = await getCurrentMidenBlock();
  const quote = await getCrossChainQuote(
    sdk,
    {
      midenAccountId: args.senderPublicKey,
      midenFaucetId: BRIDGEABLE_MIDEN_FAUCET_ID,
      midenAmount: args.amount.toString(),
      evmRecipient: args.destinationAddress,
      destinationChainId: EPOCH_DESTINATION_CHAIN_ID,
      outputTokenAddress: BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
      outputTokenDecimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
      minTokenOut: '0',
      midenReclaimHeight: currentBlock + MIDEN_MIN_RECLAIM_BLOCKS
    },
    args.sponsorAddress
  );

  const raw = quote.quoteResult.tokenOut != null ? String(quote.quoteResult.tokenOut) : '0';
  return {
    amount: formatQuoteAmount(raw, BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS),
    symbol: BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL
  };
}

export interface EpochSendArgs {
  /** Base units of the bridgeable Miden faucet token the user is sending. */
  amount: bigint;
  /** EVM recipient (0x). */
  destinationAddress: `0x${string}`;
  /** Sender's Miden account (bech32). */
  senderPublicKey: string;
  /** Connected EVM wallet address — Epoch's sponsor for the intent. */
  sponsorAddress: `0x${string}`;
  deps: BridgeNoteDeps;
}

/**
 * Fast (Epoch) Miden → EVM send. Unlike the Agglayer route, Epoch does not flow
 * through the queued background processor — it drives the Epoch store directly.
 * We bracket the quote → execute with a `bridged-send` activity row so the send
 * shows up in the progress modal and history exactly like every other tx.
 *
 * The row is created already in `GeneratingTransaction` (with `processingStartedAt`
 * set so the stuck-canceller doesn't reap it) and carries NO `requestBytes`, so
 * the background loop — which only picks up `Queued` rows — never tries to
 * `newTransaction` it. `createMidenP2IDNote` creates a separate inner `send` row
 * (the actual on-chain Miden P2IDE note); the outer `bridged-send` row records
 * the bridge intent + EVM destination. Epoch auto-settles on the destination
 * chain, so there is no manual claim (`claimStatus: 'not-applicable'`).
 */
export async function bridgeEpochSend(args: EpochSendArgs): Promise<{ txId: string }> {
  if (!isBridgeableEvmTokenConfigured()) {
    throw new Error('The Fast (Epoch) route is not configured yet — missing the EVM output token address.');
  }

  // Create the activity row first so it appears in the modal/history immediately.
  const txId = await initiateBridgedSendTransaction(
    args.senderPublicKey,
    args.amount,
    BRIDGEABLE_MIDEN_FAUCET_ID,
    args.destinationAddress,
    EPOCH_DESTINATION_CHAIN_ID,
    'epoch',
    undefined,
    true
  );
  // Move to GeneratingTransaction + stamp processingStartedAt so the queued loop
  // skips it (Queued-only) and `cancelStuckTransactions` doesn't reap it.
  await updateTransactionStatus(txId, ITransactionStatus.GeneratingTransaction, {
    processingStartedAt: Math.floor(Date.now() / 1000),
    stage: 'sending'
  });

  try {
    const store = useEpochStore.getState();
    store.reset();

    const currentBlock = await getCurrentMidenBlock();

    // Forward quote: the user enters the Miden input amount, so pass it as
    // `midenAmount` and let the backend compute the EVM output. `minTokenOut: '0'`
    // means no slippage floor (testnet); a quote preview can tighten this later.
    await store.quoteMidenToEVM(
      {
        midenAccountId: args.senderPublicKey,
        midenFaucetId: BRIDGEABLE_MIDEN_FAUCET_ID,
        midenAmount: args.amount.toString(),
        evmRecipient: args.destinationAddress,
        destinationChainId: EPOCH_DESTINATION_CHAIN_ID,
        outputTokenAddress: BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS,
        outputTokenDecimals: BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS,
        minTokenOut: '0',
        midenReclaimHeight: currentBlock + MIDEN_MIN_RECLAIM_BLOCKS
      },
      args.sponsorAddress
    );

    if (useEpochStore.getState().status !== 'quoted') {
      throw new Error(useEpochStore.getState().error ?? 'Bridge quote failed');
    }

    // Execute. createMidenP2IDNote blocks until the inner P2IDE `send` row is
    // committed on Miden, then the intent is solved/submitted (status -> pending).
    await store.executeMidenToEVM({
      collateralType: CollateralType.Miden,
      midenSourceAccount: args.senderPublicKey,
      createMidenP2IDNote: (faucet, amount, allocatorId) =>
        createBridgeP2IDNote(args.senderPublicKey, faucet, amount, allocatorId, args.deps)
    });

    const after = useEpochStore.getState();
    if (after.status === 'failed') {
      throw new Error(after.error ?? 'Bridge failed');
    }

    // Record the solver/intent hash (informational) and mark the bridge done.
    const evmTxHash = after.intent?.solveResult?.hash;
    if (evmTxHash) {
      await updateBridgeClaimStatus(txId, 'not-applicable', { evmTxHash });
    }
    await updateTransactionStatus(txId, ITransactionStatus.Completed, {
      displayMessage: 'Bridged to EVM',
      completedAt: Math.floor(Date.now() / 1000)
    });
    return { txId };
  } catch (err) {
    await cancelTransactionById(txId, err);
    throw err;
  }
}
