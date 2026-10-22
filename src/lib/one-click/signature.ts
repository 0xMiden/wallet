import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';

import { isRecord } from 'lib/update/guards';

import { isOneClickLocalE2EEnabled } from './e2e-gate';
import type { OneClickQuote, OneClickQuoteResponse, OneClickSignedRequest } from './types';

export const ONE_CLICK_MANAGER_PUBLIC_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';
const PREFIX = 'ed25519:';

function base58Encode(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

function base58Decode(value: string): Uint8Array {
  if (!value || value.length > 128) throw new Error('invalid base58');
  try {
    return bs58.decode(value);
  } catch {
    throw new Error('invalid base58');
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    return result === undefined ? 'null' : result;
  }
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item) ?? 'null').join(',')}]`;
  if (!isRecord(value)) throw new Error('unsupported value');
  const record = value;
  const fields = Object.keys(record)
    .sort()
    .filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${fields.join(',')}}`;
}

function signedRequest(request: OneClickSignedRequest): Record<string, unknown> {
  return {
    dry: request.dry,
    swapType: request.swapType,
    slippageTolerance: request.slippageTolerance,
    originAsset: request.originAsset,
    depositType: request.depositType,
    destinationAsset: request.destinationAsset,
    amount: request.amount,
    refundTo: request.refundTo,
    refundType: request.refundType,
    recipient: request.recipient,
    recipientType: request.recipientType,
    deadline: request.deadline,
    quoteWaitingTimeMs: request.quoteWaitingTimeMs ? request.quoteWaitingTimeMs : undefined,
    referral: request.referral ? request.referral : undefined,
    virtualChainRecipient: request.virtualChainRecipient ? request.virtualChainRecipient : undefined,
    virtualChainRefundRecipient: request.virtualChainRefundRecipient ? request.virtualChainRefundRecipient : undefined,
    customRecipientMsg: request.customRecipientMsg ? request.customRecipientMsg : undefined,
    sessionId: undefined,
    connectedWallets: undefined,
    correlationId: undefined,
    appFees: undefined,
    partnerId: undefined,
    userAccountId: undefined,
    depositMode: undefined
  };
}

function signedQuote(quote: OneClickQuote, dry: boolean): Record<string, unknown> {
  const shared = {
    amountIn: quote.amountIn,
    amountInFormatted: quote.amountInFormatted,
    amountInUsd: quote.amountInUsd,
    minAmountIn: quote.minAmountIn,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    amountOutUsd: quote.amountOutUsd,
    minAmountOut: quote.minAmountOut
  };
  if (dry) return shared;
  return {
    ...shared,
    depositAddress: quote.depositAddress || undefined,
    depositMemo: quote.depositMemo || undefined,
    deadline: quote.deadline || undefined,
    timeWhenInactive: quote.timeWhenInactive || undefined,
    timeEstimate: quote.timeEstimate || undefined,
    virtualChainRecipient: quote.virtualChainRecipient || undefined,
    virtualChainRefundRecipient: quote.virtualChainRefundRecipient || undefined,
    customRecipientMsg: quote.customRecipientMsg || undefined,
    refundFee: quote.refundFee || undefined,
    withdrawFee: quote.withdrawFee || undefined
  };
}

export function hashOneClickQuote(response: OneClickQuoteResponse): string {
  const payload = stableStringify({
    ...signedRequest(response.quoteRequest),
    ...signedQuote(response.quote, response.quoteRequest.dry),
    timestamp: response.timestamp
  });
  return base58Encode(sha256(new TextEncoder().encode(payload)));
}

export function verifyOneClickQuoteSignature(response: OneClickQuoteResponse, managerPublicKey?: string): boolean {
  try {
    if (!validResponse(response)) return false;
    const signature = decodeKey(response.signature, 64);
    const selectedKey =
      managerPublicKey ??
      (isOneClickLocalE2EEnabled() ? process.env.MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY : ONE_CLICK_MANAGER_PUBLIC_KEY);
    if (!selectedKey) return false;
    const publicKey = decodeKey(selectedKey, 32);
    return ed25519.verify(signature, new TextEncoder().encode(hashOneClickQuote(response)), publicKey);
  } catch {
    return false;
  }
}

function decodeKey(value: string, expectedLength: number): Uint8Array {
  const decoded = base58Decode(value.startsWith(PREFIX) ? value.slice(PREFIX.length) : value);
  if (decoded.length !== expectedLength) throw new Error('invalid key size');
  return decoded;
}

function validResponse(response: OneClickQuoteResponse): boolean {
  return (
    typeof response.signature === 'string' &&
    response.signature.length > 0 &&
    typeof response.timestamp === 'string' &&
    Number.isFinite(Date.parse(response.timestamp)) &&
    typeof response.quoteRequest?.dry === 'boolean' &&
    typeof response.quote?.amountIn === 'string' &&
    typeof response.quote?.amountOut === 'string'
  );
}
