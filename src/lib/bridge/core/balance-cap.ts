import BigNumber from 'bignumber.js';

import { USD_QUOTE_MAX_AGE_MS } from 'lib/prices/amount';

import type { BridgeRoute } from './routes';

export type BalanceCapPrices = Partial<Record<string, { usdDecimal: string; fetchedAt: number }>>;
/** pricingSymbol is supplied only by the wallet's verified faucet mapping, never by display metadata. */
export type MidenBalances = Record<string, { pricingSymbol?: string; amountRaw: bigint; decimals: number }>;
export interface BalanceCapEvaluation {
  status: 'allowed' | 'exceeded' | 'unavailable';
  balanceUsd?: string;
  remainingUsd?: string;
  depositUsd?: string;
}

const priceSymbol = (symbol: string): string => (symbol === 'USDCx' ? 'USDC' : symbol);

export function priceSymbolsForBalanceCap(route: BridgeRoute, balances?: MidenBalances): string[] {
  if (route.mode !== 'receive') return [];
  return [
    ...new Set([
      priceSymbol(route.source.symbol),
      ...Object.values(balances ?? {}).flatMap(balance =>
        balance.amountRaw > 0n && balance.pricingSymbol ? [priceSymbol(balance.pricingSymbol)] : []
      )
    ])
  ].sort();
}

/** Gross source value is conservative: a deducted provider fee never increases the deposit allowance. */
export function evaluateBalanceCap(
  route: BridgeRoute,
  amount: string,
  balances: MidenBalances | undefined,
  prices: BalanceCapPrices,
  now: number
): BalanceCapEvaluation {
  const cap = route.recovery.config.limits?.bridgeInMaxBalanceUsd;
  if (route.mode !== 'receive' || cap === undefined) return { status: 'allowed' };
  const unavailable: BalanceCapEvaluation = { status: 'unavailable' };
  if (!balances || !Number.isFinite(now) || !Number.isFinite(cap) || cap < 0) return unavailable;
  const price = (symbol: string): BigNumber | undefined => {
    const quote = prices[priceSymbol(symbol)];
    if (
      !quote ||
      !Number.isFinite(quote.fetchedAt) ||
      quote.fetchedAt > now ||
      now - quote.fetchedAt > USD_QUOTE_MAX_AGE_MS ||
      quote.usdDecimal.length > 512 ||
      !/^\d+(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i.test(quote.usdDecimal)
    )
      return undefined;
    const value = new BigNumber(quote.usdDecimal);
    return value.isFinite() && value.gt(0) ? value : undefined;
  };
  let total = new BigNumber(0);
  for (const balance of Object.values(balances)) {
    if (balance.amountRaw < 0n || !Number.isInteger(balance.decimals) || balance.decimals < 0 || balance.decimals > 255)
      return unavailable;
    if (balance.amountRaw === 0n || !balance.pricingSymbol) continue;
    const market = price(balance.pricingSymbol);
    // Known holdings wait for their market price, matching the wallet's existing settled-held-value guard.
    if (!market) return unavailable;
    total = total.plus(new BigNumber(balance.amountRaw.toString()).shiftedBy(-balance.decimals).times(market));
  }
  const market = price(route.source.symbol);
  if (!market || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) || !new BigNumber(amount).gt(0)) return unavailable;
  const deposit = new BigNumber(amount).times(market);
  return {
    status: total.plus(deposit).gt(cap.toString()) ? 'exceeded' : 'allowed',
    balanceUsd: total.toFixed(),
    remainingUsd: BigNumber.maximum(new BigNumber(cap.toString()).minus(total), 0).toFixed(),
    depositUsd: deposit.toFixed()
  };
}
