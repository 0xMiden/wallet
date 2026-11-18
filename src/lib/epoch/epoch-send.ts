import { CollateralType, type SolveIntentParams } from '@epoch-protocol/epoch-intents-sdk';
import { formatUnits, parseUnits } from 'viem';

import type { QuoteValidity } from 'lib/bridge/core/quote';
import { assertReviewedBridge } from 'lib/bridge/core/review';
import { configKey } from 'lib/bridge/core/routes';
import type { SubmissionChecks } from 'lib/bridge/core/submission';
import { captureBridgeWalletScope, findAdmittedBridgeOperation, type BridgeOperationInput } from 'lib/bridge/operation';
import { EpochReviewChangedError } from 'lib/epoch/review-error';
import { markBridgedSendFailed, updateBridgeClaimStatus } from 'lib/miden/activity';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import type { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import {
  BridgeConfigUnavailableError,
  type EvmUsdc,
  getEpochAllocatorUrl,
  getEpochOutputToken,
  getEvmChainId,
  selectEpochAllocator
} from 'lib/remote-config/values';

import {
  assertEpochReviewedOutput,
  buildCrossChainIntent,
  getCrossChainQuote,
  normalizeMidenIdToHex,
  reviewedEpochMinimum
} from './bridge';
import { getCurrentMidenBlock, MIDEN_MIN_RECLAIM_BLOCKS, MIDEN_RECLAIM_BUFFER_BLOCKS } from './chain';
import { collateralNoteMismatch, EpochCollateralNoteMismatchError } from './collateral-guard';
import { readEpochIntentStatus } from './intent-status';
import { createBridgeP2IDENote, type BridgeNoteDeps } from './miden-note';
import { getEpochReadOnlySdk } from './sdk';
import type { CrossChainIntentParams, EpochReviewedOutput, EpochReviewedQuote } from './types';

export interface EpochQuoteOutput {
  validity?: QuoteValidity;
  /** Estimated EVM output as an exact human decimal; the screens that show it round it down. */
  amount: string;
  /** Output token symbol, as its contract reports it. */
  symbol: string;
}

/**
 * The EVM token a Fast send of `faucetId` arrives as on `destinationChainId` (else the first Epoch chain). Rejects
 * while the route names no token for that faucet, before any SDK or note work.
 */
function epochOutputToken(faucetId: string, destinationChainId: number | undefined): EvmUsdc {
  return getEpochOutputToken(destinationChainId ?? getEvmChainId(), normalizeMidenIdToHex(faucetId));
}

/**
 * An Epoch quote amount (18-decimal base units, or an already-human decimal) as an exact human
 * decimal. Never rounded: the row stores it and every screen formats it when it shows it.
 */
function exactQuoteAmount(raw: string, decimals: number): string {
  try {
    return /^\d+\.\d+$/.test(raw) ? raw : formatUnits(BigInt(raw), decimals);
  } catch {
    return raw;
  }
}

/**
 * Shared forward-quote params for a Miden→EVM send. The `evmRecipient` doubles as
 * the intent sponsor (Miden collateral → solver-fulfilled EVM leg), so NO connected
 * EVM wallet is needed — only the destination address. Preview quotes start with
 * zero; execution replaces it with the mandatory positive reviewed atomic floor.
 */
function buildEpochSendParams(
  usdc: EvmUsdc,
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
    destinationChainId: usdc.chainId,
    outputTokenAddress: usdc.address,
    outputTokenDecimals: usdc.decimals,
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
  destinationChainId?: number;
}): Promise<EpochQuoteOutput> {
  const usdc = epochOutputToken(args.faucetId, args.destinationChainId);
  const allocatorUrl = getEpochAllocatorUrl();
  const sdk = await getEpochReadOnlySdk(args.destinationAddress, allocatorUrl);
  const currentBlock = await getCurrentMidenBlock();
  const params = buildEpochSendParams(
    usdc,
    args.amount,
    args.faucetId,
    args.destinationAddress,
    args.senderPublicKey,
    currentBlock
  );
  const quote = await getCrossChainQuote(sdk, params, args.destinationAddress);

  const raw = quote.quoteResult.tokenOut != null ? String(quote.quoteResult.tokenOut) : '0';
  return {
    amount: exactQuoteAmount(raw, usdc.decimals),
    symbol: usdc.symbol,
    // The installed quote API exposes no expiry; provider validity is not a time guarantee.
    validity: { kind: 'provider' }
  };
}

export { reviewedEpochMinimum } from './bridge';

export interface EpochSendArgs {
  /** Base units of the Miden faucet token the user is sending. */
  amount: bigint;
  minimumOutputBaseUnits: bigint;
  reviewedQuote?: EpochReviewedQuote;
  operation?: BridgeOperationInput;
  checks?: Pick<SubmissionChecks, 'readCurrent' | 'now'>;
  /** Miden faucet id of the token being bridged. Epoch accepts any token (hex or bech32). */
  faucetId: string;
  /** EVM recipient (0x) — also the intent sponsor; no connected wallet required. */
  destinationAddress: `0x${string}`;
  /** Sender's Miden account (bech32). */
  senderPublicKey: string;
  destinationChainId?: number;
  deps: BridgeNoteDeps;
  /**
   * Fired once the `bridged-send` row is created (mid-solve, before it proves +
   * submits). The send flow navigates to the generating-transaction screen with
   * this txId so it tracks the real row instead of racing an empty queue.
   */
  onRowCreated?: (txId: string) => void;
  spendingLimitAuthorization?: SpendingLimitAuthorization;
}

function reviewedOutputOf(args: EpochSendArgs): EpochReviewedOutput | undefined {
  let quote = args.reviewedQuote;
  if (args.operation !== undefined) {
    const { review } = args.operation;
    const { route, accounts } = review;
    const chain = route.recovery.config.supportedEvmChains[route.destination.network];
    if (
      route.provider !== 'epoch' ||
      route.mode !== 'send' ||
      route.source.kind !== 'miden' ||
      route.destination.kind === 'miden' ||
      !chain ||
      !review.quote ||
      review.quote.kind !== 'epoch' ||
      !sameWalletAccountId(accounts.midenAccount, args.senderPublicKey) ||
      !sameWalletAccountId(route.source.faucetId, args.faucetId) ||
      reviewedEpochMinimum(review.amount, route.source.decimals) !== args.amount ||
      accounts.evmAddress.toLowerCase() !== args.destinationAddress.toLowerCase() ||
      chain.chainId !== args.destinationChainId ||
      reviewedEpochMinimum(review.quote.received, route.destination.decimals) !== args.minimumOutputBaseUnits
    )
      throw new EpochReviewChangedError();
    const token =
      route.destination.kind === 'native' ? '0x0000000000000000000000000000000000000000' : route.destination.address;
    const owned: EpochReviewedQuote = {
      validity: review.quote.validity,
      outputTokenAddress: `0x${token.slice(2).toLowerCase()}`,
      outputTokenDecimals: route.destination.decimals
    };
    if (
      quote !== undefined &&
      configKey({ ...quote, outputTokenAddress: quote.outputTokenAddress.toLowerCase() }) !== configKey(owned)
    )
      throw new EpochReviewChangedError();
    quote = owned;
  }
  return quote === undefined ? undefined : { ...quote, minimumOutputBaseUnits: args.minimumOutputBaseUnits.toString() };
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
  args = {
    ...args,
    operation: args.operation === undefined ? undefined : structuredClone(args.operation),
    reviewedQuote: args.reviewedQuote === undefined ? undefined : structuredClone(args.reviewedQuote)
  };
  if (
    typeof args.minimumOutputBaseUnits !== 'bigint' ||
    args.minimumOutputBaseUnits <= 0n ||
    args.minimumOutputBaseUnits >= 1n << 256n
  )
    throw new Error('Epoch requires a positive reviewed output minimum');
  const reviewedOutput = reviewedOutputOf(args);
  const originalScope = reviewedOutput ? captureBridgeWalletScope() : undefined;
  if (args.operation) {
    const original = await findAdmittedBridgeOperation(args.operation);
    if (original) return { txId: original.id };
  }
  const snapshot = getBridgeConfigSnapshot();
  const snapshotKey = configKey([snapshot.network, snapshot.status, snapshot.config, snapshot.derived]);
  const usdc = epochOutputToken(args.faucetId, args.destinationChainId);
  const assertCurrent = () => {
    if (!reviewedOutput || !originalScope) return;
    assertEpochReviewedOutput(reviewedOutput);
    const currentScope = captureBridgeWalletScope();
    const current = getBridgeConfigSnapshot();
    if (
      snapshot.status !== 'ready' ||
      originalScope.network !== currentScope.network ||
      originalScope.rpcUrl !== currentScope.rpcUrl ||
      snapshotKey !== configKey([current.network, current.status, current.config, current.derived]) ||
      usdc.address.toLowerCase() !== reviewedOutput.outputTokenAddress.toLowerCase() ||
      usdc.decimals !== reviewedOutput.outputTokenDecimals
    )
      throw new EpochReviewChangedError();
    if (args.operation) {
      const review = args.operation.review;
      const recovery = review.route.recovery;
      if (
        originalScope.network !== recovery.network ||
        configKey([snapshot.network, snapshot.config, snapshot.derived]) !==
          configKey([recovery.network, recovery.config, recovery.derived])
      )
        throw new EpochReviewChangedError();
      assertReviewedBridge(review, review, Date.now());
    }
  };
  const assertLive = async () => {
    if (args.operation) {
      if (!args.checks) throw new EpochReviewChangedError();
      assertReviewedBridge(args.operation.review, await args.checks.readCurrent(), args.checks.now());
    }
    assertCurrent();
  };
  await assertLive();
  const allocator = selectEpochAllocator(snapshot);
  if (allocator === null) {
    throw new BridgeConfigUnavailableError('epoch.allocatorUrl');
  }
  const { allocatorUrl, accountId } = allocator;
  const sdk = await getEpochReadOnlySdk(args.destinationAddress, allocatorUrl);
  await assertLive();
  const currentBlock = await getCurrentMidenBlock();
  await assertLive();
  const params = buildEpochSendParams(
    usdc,
    args.amount,
    args.faucetId,
    args.destinationAddress,
    args.senderPublicKey,
    currentBlock
  );

  params.minTokenOut = args.minimumOutputBaseUnits.toString();

  // Forward quote (input → output), then solve. `createMidenP2IDENote` blocks until
  // the P2IDE `bridged-send` row is committed on Miden before the intent is
  // submitted. The sponsor is the recipient (set inside buildCrossChainIntent). We
  // capture the row id from the callback so we can patch the EVM solve hash on it.
  let bridgeTxId: string | undefined;
  let noteError: unknown;
  let observerError: unknown;
  let noteKey: string | undefined;
  let noteResult: ReturnType<NonNullable<SolveIntentParams['createMidenP2IDENote']>> | undefined;
  const quote = await getCrossChainQuote(sdk, params, args.destinationAddress);
  await assertLive();
  const output = quote.quoteResult.tokenOut;
  if (
    typeof output !== 'string' ||
    !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(output) ||
    (output.includes('.') && (output.split('.')[1]?.length ?? 0) > usdc.decimals)
  )
    throw new Error('Epoch returned an invalid output quote');
  const outputBaseUnits = output.includes('.') ? parseUnits(output, usdc.decimals) : BigInt(output);
  if (outputBaseUnits < args.minimumOutputBaseUnits) throw new Error('Epoch output is below the reviewed minimum');
  const intent = await buildCrossChainIntent(sdk, {
    ...params,
    preFetchedQuote: quote,
    collateralType: CollateralType.Miden,
    midenSourceAccount: args.senderPublicKey,
    createMidenP2IDENote: (faucet, amount, allocatorId, recallBlocks, bindingAttachmentFelts) => {
      const key = JSON.stringify([
        normalizeMidenIdToHex(faucet).toLowerCase(),
        amount,
        normalizeMidenIdToHex(allocatorId).toLowerCase(),
        recallBlocks,
        bindingAttachmentFelts.map(String)
      ]);
      if (noteResult) {
        if (key === noteKey) return noteResult;
        noteError ??= new EpochReviewChangedError();
        return Promise.resolve({ success: false });
      }
      noteKey = key;
      try {
        const mismatch = collateralNoteMismatch(
          { faucetId: faucet, amount, allocatorId },
          { faucetId: args.faucetId, amount: args.amount, allocatorAccountId: accountId }
        );
        if (mismatch !== null) throw new EpochCollateralNoteMismatchError(mismatch);
        assertCurrent();
      } catch (error) {
        noteError ??= error;
        noteResult = Promise.resolve({ success: false });
        return noteResult;
      }
      noteResult = (async () => {
        try {
          const res = await createBridgeP2IDENote({
            senderAccountId: args.senderPublicKey,
            faucetId: faucet,
            amount,
            allocatorId,
            recallBlocks,
            bindingAttachmentFelts: [...bindingAttachmentFelts],
            destinationAddress: args.destinationAddress,
            destinationNetwork: usdc.chainId,
            allocatorUrl,
            deps: args.deps,
            operation: args.operation,
            reviewedOutput: reviewedOutput && !args.operation ? { ...reviewedOutput, walletScope: originalScope } : reviewedOutput,
            expectedWalletScope: originalScope,
            checks: args.checks,
            onRowCreated: txId => {
              bridgeTxId = txId;
              try {
                args.onRowCreated?.(txId);
              } catch (error) {
                observerError ??= error;
              }
            },
            spendingLimitAuthorization: args.spendingLimitAuthorization
          });
          if (res.txId) bridgeTxId = res.txId;
          return { success: res.success, noteId: res.noteId };
        } catch (error) {
          noteError ??= error;
          return { success: false };
        }
      })();
      return noteResult;
    }
  });
  // Persist the quote output + intent nonce so the activity view can render the
  // "you received N USDC" side and later poll `getIntentStatus` for the
  // receiving-chain fill. `updateBridgeClaimStatus` mutates extraInputs only, so
  // it's fine that the row is already Completed.
  const evmTxHash = intent.solveResult?.hash;
  const intentNonce = intent.intentNonce ?? intent.solveResult?.nonce;
  const rawTokenOut = quote.quoteResult.tokenOut != null ? String(quote.quoteResult.tokenOut) : '0';
  const outputAmount = exactQuoteAmount(rawTokenOut, usdc.decimals);
  if (bridgeTxId) {
    await updateBridgeClaimStatus(bridgeTxId, 'not-applicable', {
      ...(evmTxHash === undefined ? {} : { evmTxHash }),
      ...(intentNonce === undefined ? {} : { intentNonce }),
      outputAmount,
      outputSymbol: usdc.symbol,
      epochStatus: 'pending'
    });
  }
  if (intent.error && bridgeTxId) await markBridgedSendFailed(bridgeTxId, intent.error);
  if (noteError !== undefined) throw noteError;
  if (intent.error) throw new Error(intent.error);
  if (observerError !== undefined) throw observerError;
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
 * or `null` if nothing is queryable yet (no nonce, network error, no configured chain).
 *
 * The status array can carry entries for multiple chains; only the entry on the
 * destination EVM chain the config names decides the fill. `confirmed` requires
 * that entry to report a done status.
 */
export async function pollEpochIntentFill(args: {
  destinationAddress: string;
  intentNonce: string;
  destinationChainId?: number;
  allocatorUrl?: string;
}): Promise<EpochIntentFill | null> {
  if (!args.intentNonce || !isEvmAddress(args.destinationAddress)) return null;
  try {
    const sdk = await getEpochReadOnlySdk(args.destinationAddress, args.allocatorUrl);
    const destinationChainId = args.destinationChainId ?? getEvmChainId();
    const results = await readEpochIntentStatus(sdk, args.destinationAddress, args.intentNonce);
    if (!results || results.length === 0) return { status: 'pending' };

    // Only the destination leg decides the fill. Falling back to an arbitrary last
    // entry would let a done status on the Miden *source* leg flip the row to
    // Confirmed before the EVM leg settles, and surface a non-Sepolia tx hash under
    // a sepolia.etherscan.io link. When no destination entry exists yet, stay pending.
    const onDest = results.find(r => r.chainId === destinationChainId);
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
    console.error('[epoch] pollEpochIntentFill failed', args.destinationAddress, args.intentNonce, err);
    return null;
  }
}
