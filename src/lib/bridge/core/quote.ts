import BigNumber from 'bignumber.js';

import type { CctpBurnQuote } from 'lib/usdcx/cctp';

import { bridgeFeeCharging } from './provider';
import type { BridgeRecoveryConfig, BridgeRoute } from './routes';
import { validateTransferAmount } from './rules';

export interface QuoteRequest {
  route: BridgeRoute;
  amount: string;
  midenAccount: string;
  evmAddress: string;
}
export type QuoteValidity = { kind: 'time'; expiresAt: number } | { kind: 'provider' };
export type QuoteResult = { received: string; fee?: string; validity: QuoteValidity } & (
  | { kind: 'epoch' | 'agglayer' | 'arc-deposit' | 'withdrawal' }
  | { kind: 'cctp'; authorization: CctpBurnQuote }
);
export type TransferQuote = QuoteResult & {
  request: Omit<QuoteRequest, 'route'> & { routeId: string; recovery: BridgeRecoveryConfig };
};

export function isQuoteReviewable(quote: QuoteResult | null | undefined, now: number): quote is QuoteResult {
  return Boolean(
    quote &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(quote.received) &&
    new BigNumber(quote.received).gt(0) &&
    (quote.validity.kind === 'provider' ||
      (Number.isFinite(quote.validity.expiresAt) && quote.validity.expiresAt > now))
  );
}

export function bindTransferQuote(request: QuoteRequest, quote: QuoteResult): TransferQuote {
  validateTransferAmount(request.route, request.amount);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(quote.received) || !new BigNumber(quote.received).gt(0)) {
    throw new Error('Missing positive bridge quote output');
  }
  const { route, ...terms } = request;
  return {
    ...structuredClone(quote),
    request: { ...terms, routeId: route.id, recovery: structuredClone(route.recovery) }
  };
}

export function quoteAmounts(
  route: BridgeRoute,
  quote: TransferQuote
): { received: string; sourceTotal: string; fee?: string } {
  const authorizedFee =
    quote.kind === 'cctp'
      ? new BigNumber(quote.authorization.feeTotalAmount.toString()).shiftedBy(-route.source.decimals)
      : undefined;
  if (authorizedFee && (authorizedFee.lt(0) || (quote.fee !== undefined && !authorizedFee.eq(quote.fee))))
    throw new Error('Bridge forwarding fee terms changed');
  const fee = quote.fee ?? authorizedFee?.toFixed();
  if (fee !== undefined && (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(fee) || !new BigNumber(fee).isFinite())) {
    throw new Error('Invalid bridge quote fee');
  }
  const sourceTotal =
    bridgeFeeCharging(route) === 'additional' && fee !== undefined
      ? new BigNumber(quote.request.amount).plus(fee).toFixed()
      : quote.request.amount;
  return { received: quote.received, sourceTotal, ...(fee === undefined ? {} : { fee }) };
}
