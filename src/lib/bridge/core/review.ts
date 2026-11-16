import { isBridgeRouteAvailable } from './provider';
import { isQuoteReviewable, type TransferQuote } from './quote';
import { configKey, routeMatchesRecovery, type BridgeRoute } from './routes';
import { validateTransferAmount } from './rules';

export interface ReviewedTransfer {
  route: BridgeRoute;
  amount: string;
  accounts: { midenAccount: string; evmAddress: string };
  quote?: TransferQuote;
}
export interface BridgeReviewContext {
  route: BridgeRoute;
  amount: string;
  accounts: ReviewedTransfer['accounts'];
}

/** Call after every asynchronous admission read; a stored review is never fresh signing permission. */
export function assertReviewedBridge(review: ReviewedTransfer, current: BridgeReviewContext, now: number): void {
  const { route, amount, accounts, quote } = review;
  validateTransferAmount(current.route, current.amount);
  if (
    route.disabled ||
    !isBridgeRouteAvailable(current.route) ||
    !routeMatchesRecovery(current.route) ||
    configKey(route) !== configKey(current.route) ||
    amount !== current.amount ||
    !accounts.midenAccount ||
    !/^0x[\da-f]{40}$/i.test(accounts.evmAddress) ||
    accounts.midenAccount !== current.accounts.midenAccount ||
    accounts.evmAddress.toLowerCase() !== current.accounts.evmAddress.toLowerCase()
  ) {
    throw new Error('Bridge review terms changed');
  }
  if (
    !isQuoteReviewable(quote, now) ||
    quote.request.routeId !== route.id ||
    quote.request.amount !== amount ||
    quote.request.midenAccount !== accounts.midenAccount ||
    quote.request.evmAddress.toLowerCase() !== accounts.evmAddress.toLowerCase() ||
    configKey(quote.request.recovery) !== configKey(route.recovery) ||
    (route.provider === 'epoch' && quote.kind !== 'epoch') ||
    (route.provider === 'agglayer' && quote.kind !== 'agglayer') ||
    (route.provider === 'xreserve' &&
      (route.mode === 'send' ? quote.kind !== 'withdrawal' : quote.kind !== 'cctp' && quote.kind !== 'arc-deposit'))
  ) {
    throw new Error('Bridge quote requires a new review');
  }
}
