import type { CctpBurnQuote } from 'lib/usdcx/cctp';

import type { BridgeRecoveryConfig, BridgeRoute } from './routes';

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
export function isQuoteReviewable(_quote: QuoteResult | null | undefined, _now: number): boolean {
  throw new Error('Unsupported bridge core');
}
export function bindTransferQuote(_request: QuoteRequest, _quote: QuoteResult): TransferQuote {
  throw new Error('Unsupported bridge core');
}
export function quoteAmounts(
  _route: BridgeRoute,
  _quote: TransferQuote
): { received: string; sourceTotal: string; fee?: string } {
  throw new Error('Unsupported bridge core');
}
