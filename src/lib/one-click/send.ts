import type { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { normalizedFaucetId } from 'lib/miden/swap/faucet-ids';
import { isPreviewRefundAddress } from 'screens/near-intents-flow/preview-refund';

import { isValidNearIntentsAddress } from './address';
import { nearIntentsEvmChainId } from './chains';
import { requestOneClickQuote } from './client';
import { initiateOneClickMidenDeposit } from './tracking';
import type {
  NearIntentsAddressKind,
  NearIntentsCatalog,
  NearIntentsCatalogChain,
  NearIntentsConfig,
  OneClickAsset,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from './types';

/** The life of a send quote request: the same 5 minutes as the Receive form (`QUOTE_LIFETIME_MS`). */
export const NEAR_INTENTS_SEND_QUOTE_LIFETIME_MS = 5 * 60_000;
/** Each send quote allows 1% of slippage, in basis points, as the Receive form does. */
export const NEAR_INTENTS_SEND_SLIPPAGE_BPS = 100;

/** The deposit quote gives a lower output than the output that the user reviewed. */
export class NearIntentsSendQuoteChangedError extends Error {
  constructor(
    readonly reviewedMinAmountOut: bigint,
    readonly quotedMinAmountOut: bigint
  ) {
    super('The 1Click deposit quote gives less than the reviewed amount. Review the send again.');
    this.name = 'NearIntentsSendQuoteChangedError';
  }
}

/**
 * One destination chain that the config offers for a send. `evmChainId` is set only for an EVM chain the wallet
 * knows.
 */
export interface NearIntentsSendChain {
  /** The 1Click blockchain name: 'eth', 'sol', 'btc', 'near'. */
  id: string;
  /** The config's display name. */
  name: string;
  addressKind: NearIntentsAddressKind;
  evmChainId?: number;
}

export { nearIntentsEvmChainId };

/** The destination chains of the config, in the config's order. Synchronous: it reads only the config. */
export function nearIntentsSendChains(config: NearIntentsConfig | null): readonly NearIntentsSendChain[] {
  // A config that a tracking row stored before NEAR Intents moved to the Receive page has no `chains`.
  if (!config || !Array.isArray(config.chains)) return [];
  return config.chains.map(chain => {
    const evmChainId = chain.addressKind === 'evm' ? nearIntentsEvmChainId(chain.id) : undefined;
    return {
      id: chain.id,
      name: chain.name,
      addressKind: chain.addressKind,
      ...(evmChainId === undefined ? {} : { evmChainId })
    };
  });
}

/** One confirmed pair in the send direction. */
export interface NearIntentsSendPair {
  /** The chain from the confirmed catalog. */
  chain: NearIntentsCatalogChain;
  /** The Miden asset (blockchain 'miden', has faucetId). */
  origin: OneClickAsset;
  /** The token on the destination chain. */
  destination: OneClickAsset;
}

/** True when two faucet ids name the same faucet. Each id can be hex, bech32 or a composite `<address>_<suffix>`. */
function sameFaucet(left: string, right: string): boolean {
  if (left.toLowerCase() === right.toLowerCase()) return true;
  return normalizedFaucetId(left).toLowerCase() === normalizedFaucetId(right).toLowerCase();
}

/**
 * The confirmed pairs that send the Miden faucet `faucetId` to chain `chainId`, in catalog order.
 * The faucet ids are compared in their canonical form, so `faucetId` can be hex or bech32.
 */
export function findNearIntentsSendPairs(
  catalog: NearIntentsCatalog,
  faucetId: string,
  chainId: string
): NearIntentsSendPair[] {
  const chain = catalog.chains.find(entry => entry.id === chainId);
  if (!chain || !faucetId) return [];
  return chain.tokens.flatMap(token =>
    token.outputs.flatMap(output =>
      output.blockchain === 'miden' && output.faucetId !== undefined && sameFaucet(output.faucetId, faucetId)
        ? [{ chain, origin: output, destination: token.asset }]
        : []
    )
  );
}

export interface NearIntentsSendQuoteInput {
  pair: NearIntentsSendPair;
  /** Miden base units, exact input. */
  amount: bigint;
  /** The destination address, already normalized. */
  recipient: string;
  /** The wallet's bech32 Miden address. */
  refundTo: string;
}

function assertSendInput(input: NearIntentsSendQuoteInput): void {
  const { pair } = input;
  if (pair.origin.blockchain !== 'miden' || !pair.origin.faucetId || pair.destination.blockchain === 'miden') {
    throw new Error('A NEAR Intents send requires a pair from Miden to another chain.');
  }
  if (pair.destination.blockchain !== pair.chain.id) {
    throw new Error('The NEAR Intents send pair names another chain.');
  }
  if (input.amount <= 0n) throw new Error('The NEAR Intents send amount must be more than zero.');
  if (!isValidNearIntentsAddress(pair.chain.addressKind, input.recipient)) {
    throw new Error('The NEAR Intents recipient is not a valid address on the destination chain.');
  }
  if (!input.refundTo || input.refundTo.startsWith('0x') || input.refundTo.startsWith('0X')) {
    throw new Error('The NEAR Intents refund address must be the bech32 Miden address of the wallet.');
  }
}

/**
 * The quote request of a send: EXACT_INPUT, slippage 100 (1%), and a deadline 5 minutes after `now`, as the
 * Receive form does.
 */
export function buildNearIntentsSendRequest(input: NearIntentsSendQuoteInput, now = Date.now()): OneClickQuoteRequest {
  return {
    amount: input.amount.toString(),
    originAsset: input.pair.origin,
    destinationAsset: input.pair.destination,
    refundTo: input.refundTo,
    recipient: input.recipient,
    deadline: new Date(now + NEAR_INTENTS_SEND_QUOTE_LIFETIME_MS).toISOString(),
    slippageTolerance: NEAR_INTENTS_SEND_SLIPPAGE_BPS
  };
}

/** A dry quote (no deposit address). Throws `OneClickHttpError` with its code on a refused request. */
export async function requestNearIntentsSendPreview(
  config: NearIntentsConfig,
  input: NearIntentsSendQuoteInput
): Promise<{ request: OneClickQuoteRequest; quote: OneClickQuoteResponse }> {
  assertSendInput(input);
  const request = buildNearIntentsSendRequest(input);
  const quote = await requestOneClickQuote(config, request, true);
  return { request, quote };
}

export interface StartNearIntentsSendInput extends NearIntentsSendQuoteInput {
  config: NearIntentsConfig;
  /** The effective Miden network name, as the Receive flow passes it to tracking. */
  network: string;
  /** The sender account id as the transaction pipeline wants it (the account `publicKey`). */
  accountId: string;
  /** The wallet's bech32 address (same as refundTo). */
  accountAddress: string;
  /** The lowest output the user reviewed, in destination base units. The deposit quote must not be below it. */
  reviewedMinAmountOut?: bigint;
  authorization?: SpendingLimitAuthorization;
}

/**
 * Request a deposit quote (dry = false), check it, then queue the Miden send to the deposit address through
 * `initiateOneClickMidenDeposit`. Returns the transaction row id. Refuses a quote whose `minAmountOut` is below
 * `reviewedMinAmountOut`, a preview placeholder address, and a pair that is not a Miden origin.
 */
export async function startNearIntentsSend(input: StartNearIntentsSendInput): Promise<string> {
  assertSendInput(input);
  // A preview placeholder must never go into a deposit quote.
  if (isPreviewRefundAddress(input.recipient) || isPreviewRefundAddress(input.refundTo)) {
    throw new Error('A NEAR Intents send cannot use a preview placeholder address.');
  }
  // The send pipeline and the tracking row compare the faucet id with the config as written, so use that form.
  const configured = input.config.midenAssets.find(asset => asset.assetId === input.pair.origin.assetId);
  if (!configured || !sameFaucet(configured.faucetId, input.pair.origin.faucetId ?? '')) {
    throw new Error('The NEAR Intents Miden asset is not in the configuration.');
  }

  const request = buildNearIntentsSendRequest(input);
  // `requestOneClickQuote` checks the signature, the binding to the request, the deposit address, the deadline
  // and the configured pair.
  const quote = await requestOneClickQuote(input.config, request, false);
  const depositAddress = quote.quote.depositAddress;
  if (!depositAddress || isPreviewRefundAddress(depositAddress)) {
    throw new Error('The 1Click deposit quote has no usable deposit address. Request a new quote.');
  }
  if (input.reviewedMinAmountOut !== undefined) {
    const quotedMinAmountOut = BigInt(quote.quote.minAmountOut);
    if (quotedMinAmountOut < input.reviewedMinAmountOut) {
      throw new NearIntentsSendQuoteChangedError(input.reviewedMinAmountOut, quotedMinAmountOut);
    }
  }

  return initiateOneClickMidenDeposit(
    {
      request,
      quote,
      config: input.config,
      network: input.network,
      accountId: input.accountId,
      accountAddress: input.accountAddress,
      originAsset: input.pair.origin,
      destinationAsset: input.pair.destination,
      faucetId: configured.faucetId
    },
    input.authorization
  );
}
