import { useHiddenTokens } from 'app/hooks/useHiddenTokens';
import { readBalanceSnapshot } from 'lib/miden/balance-snapshot';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { valuedBalanceTotal } from 'lib/miden/front/fiat-total';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { tokenQuote } from 'lib/miden/swap/tokens';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { useWalletStore } from 'lib/store';

const CURRENT_MS = 15 * 60_000;
const EMPTY_ROWS: TokenBalanceData[] = [];

export function useCommandPortfolio(scope: AccountScope) {
  const storedRows = useWalletStore(state => state.balances[scope.accountId]);
  const isLoading = useWalletStore(
    state => state.balancesLoading[scope.accountId] ?? state.balances[scope.accountId] === undefined
  );
  const rows = storedRows ?? EMPTY_ROWS;
  const tokenPrices = useWalletStore(state => state.tokenPrices);
  const pricesStatus = useWalletStore(state => state.tokenPricesStatus);
  const { isHidden, loaded: hiddenReady } = useHiddenTokens(scope.accountId);

  let held = false;
  const pricedRows: TokenBalanceData[] = [];
  const pricedValues: { tokenId: string; value: number }[] = [];
  let partial = false;
  let staleQuote = false;
  let hasMarketValue = false;
  const priced: string[] = [];
  const unpriced: string[] = [];
  const assets = rows.filter(row => !isHidden(row.tokenId));
  for (const row of assets) {
    if (!Number.isFinite(row.balance) || row.balance <= 0) continue;
    held = true;
    const quote = tokenQuote(tokenPrices, row.tokenId, row.metadata.symbol);
    if (
      !hasKnownScale(row.metadata) ||
      !quote ||
      quote.kind === 'nominal' ||
      !Number.isFinite(quote.price) ||
      quote.price <= 0
    ) {
      partial = true;
      unpriced.push(row.tokenId);
      continue;
    }
    if (
      quote.kind !== 'fixed' &&
      (!quote.observedAt || Date.now() - quote.observedAt > CURRENT_MS || quote.observedAt > Date.now())
    ) {
      staleQuote = true;
      partial = true;
      unpriced.push(row.tokenId);
      continue;
    }
    const value = row.balance * quote.price;
    if (!Number.isFinite(value)) {
      partial = true;
      unpriced.push(row.tokenId);
      continue;
    }
    hasMarketValue ||= quote.kind !== 'fixed';
    pricedRows.push(row);
    pricedValues.push({ tokenId: row.tokenId, value });
    priced.push(row.tokenId);
  }
  const proof = storedRows === rows ? readBalanceSnapshot(rows, scope) : null;
  const current = Boolean(
    proof?.capturedAt && proof.capturedAt <= Date.now() && Date.now() - proof.capturedAt <= CURRENT_MS
  );
  const { totalFiat: total, previousFiat } = valuedBalanceTotal(pricedRows, tokenPrices);
  const empty =
    current && !isLoading && hiddenReady && rows.length > 0 && rows.every(row => row.balanceBaseUnits === '0');
  // Fixed quotes and a proven empty vault do not depend on the market feed.
  const canValueWithoutFeed = empty || (held && !partial && !hasMarketValue);
  const value =
    current && hiddenReady && (pricesStatus === 'ready' || canValueWithoutFeed) && (!held || pricedRows.length > 0)
      ? String(total)
      : null;
  const allocation =
    value !== null && !isLoading && Number.isFinite(total) && total > 0
      ? pricedValues.map(row => ({ ...row, percentage: (row.value / total) * 100 }))
      : [];
  const move = total - previousFiat;
  const percentage = (move / previousFiat) * 100;
  const marketPriced = pricedRows.some(row => {
    const quote = tokenQuote(tokenPrices, row.tokenId, row.metadata.symbol);
    return quote && quote.kind !== 'fixed' && Number.isFinite(quote.change24h);
  });
  const priceMovement24h =
    value !== null &&
    !isLoading &&
    marketPriced &&
    previousFiat > 0 &&
    Number.isFinite(move) &&
    Number.isFinite(percentage)
      ? { absolute: move, percentage }
      : null;
  const coverage: 'complete' | 'partial' = partial ? 'partial' : 'complete';
  return {
    assets: current && hiddenReady ? assets : [],
    allocation,
    tokenPrices,
    value,
    priceMovement24h,
    coverage,
    coverageKey: `priced:${priced.sort().join(',')}|unpriced:${unpriced.sort().join(',')}`,
    capturedAt: proof?.capturedAt,
    current: current && !isLoading,
    empty,
    canRecord:
      current &&
      rows.length > 0 &&
      !isLoading &&
      hiddenReady &&
      pricesStatus === 'ready' &&
      !staleQuote &&
      value !== null
  };
}
