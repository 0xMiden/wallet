import type { BridgeRoute } from './routes';

export type BalanceCapPrices = Partial<Record<string, { usdDecimal: string; fetchedAt: number }>>;
export type MidenBalances = Record<string, { pricingSymbol?: string; amountRaw: bigint; decimals: number }>;
export interface BalanceCapEvaluation {
  status: 'allowed' | 'exceeded' | 'unavailable';
  balanceUsd?: string;
  remainingUsd?: string;
  depositUsd?: string;
}
export function evaluateBalanceCap(
  _route: BridgeRoute,
  _amount: string,
  _balances: MidenBalances | undefined,
  _prices: BalanceCapPrices,
  _now: number
): BalanceCapEvaluation {
  throw new Error('Unsupported bridge core');
}
export function priceSymbolsForBalanceCap(_route: BridgeRoute, _balances?: MidenBalances): string[] {
  throw new Error('Unsupported bridge core');
}
