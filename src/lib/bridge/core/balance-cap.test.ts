import { evaluateBalanceCap, priceSymbolsForBalanceCap, type BalanceCapPrices } from './balance-cap';
import { now, testRoute } from '../testing/fixtures';

const receive = testRoute();
receive.source.symbol = 'USDC';
const prices: BalanceCapPrices = {
  USDC: { usdDecimal: '1', fetchedAt: now },
  ETH: { usdDecimal: '3000', fetchedAt: now },
  WBTC: { usdDecimal: '100000', fetchedAt: now }
};
const holding = (pricingSymbol: string | undefined, amountRaw: bigint, decimals = 6) => ({
  pricingSymbol,
  amountRaw,
  decimals
});

it.each([
  ['232.462', 'allowed'],
  ['232.462001', 'exceeded'],
  ['300', 'exceeded']
])('compares the exact $1000 balance plus %s with the accepted cap', (amount, status) => {
  expect(evaluateBalanceCap(receive, amount, { usdc: holding('USDC', 1_000_000_000n) }, prices, now)).toMatchObject({
    status,
    balanceUsd: '1000',
    remainingUsd: '232.462'
  });
});
it('values every trusted priced holding and does not round a fractional-cent excess down', () => {
  const balances = {
    usdc: holding('USDC', 100_000_000n),
    eth: holding('ETH', 30_000_000n, 8),
    btc: holding('WBTC', 100_000n, 8)
  };
  expect(evaluateBalanceCap(receive, '300', balances, prices, now)).toMatchObject({
    status: 'exceeded',
    balanceUsd: '1100'
  });
  expect(priceSymbolsForBalanceCap(receive, balances)).toEqual(['ETH', 'USDC', 'WBTC']);
  expect(
    evaluateBalanceCap(receive, '1232.462', {}, { USDC: { usdDecimal: '1.00000000000000000001', fetchedAt: now } }, now)
  ).toMatchObject({
    status: 'exceeded',
    depositUsd: '1232.46200000000000001232462'
  });
});
it('does not use a missing, stale, future, zero or invalid deposit price as par', () => {
  for (const quote of [
    undefined,
    { usdDecimal: '1', fetchedAt: now - 600_001 },
    { usdDecimal: '1', fetchedAt: now + 1 },
    { usdDecimal: '0', fetchedAt: now },
    { usdDecimal: 'NaN', fetchedAt: now }
  ]) {
    expect(evaluateBalanceCap(receive, '1', {}, { USDC: quote }, now).status).toBe('unavailable');
  }
  expect(evaluateBalanceCap(receive, '1', undefined, prices, now).status).toBe('unavailable');
});
it('waits for known holdings prices but does not give an unknown faucet a price based on its display symbol', () => {
  expect(evaluateBalanceCap(receive, '1', { eth: holding('ETH', 1n) }, { USDC: prices.USDC }, now).status).toBe(
    'unavailable'
  );
  expect(evaluateBalanceCap(receive, '1', { unknown: holding(undefined, 1_000_000_000n) }, prices, now)).toMatchObject({
    status: 'allowed',
    balanceUsd: '0'
  });
  expect(evaluateBalanceCap(receive, '1', { bad: holding('ETH', -1n) }, prices, now).status).toBe('unavailable');
});
it('uses the current accepted cap instead of the portal constant and never caps withdrawals', () => {
  const route = testRoute();
  route.source.symbol = 'USDC';
  route.recovery.config.limits = { bridgeInMaxBalanceUsd: 1 };
  expect(evaluateBalanceCap(route, '1.000001', {}, prices, now).status).toBe('exceeded');
  delete route.recovery.config.limits;
  expect(evaluateBalanceCap(route, '2000', undefined, {}, now).status).toBe('allowed');
  expect(evaluateBalanceCap(testRoute('send'), '2000', undefined, {}, now).status).toBe('allowed');
  expect(priceSymbolsForBalanceCap(testRoute('send'))).toEqual([]);
});
