import { useHiddenTokens } from 'app/hooks/useHiddenTokens';
import { readBalanceSnapshot } from 'lib/miden/balance-snapshot';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { valuedBalanceTotal } from 'lib/miden/front/fiat-total';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { quoteMayArrive, tokenQuote } from 'lib/miden/swap/tokens';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { selectDisplayQuotes, useCachedDisplayQuotes } from 'lib/prices/display-cache';
import { DISPLAY_QUOTE_MAX_AGE_MS } from 'lib/prices/display-feed';
import { useWalletStore } from 'lib/store';

// How old a balance proof or market quote may be for the portfolio history; the figure shows older last-known values.
const CURRENT_MS = 15 * 60_000;
const EMPTY_ROWS: TokenBalanceData[] = [];

export function useCommandPortfolio(scope: AccountScope) {
  const storedRows = useWalletStore(state => state.balances[scope.accountId]);
  const isLoading = useWalletStore(
    state => state.balancesLoading[scope.accountId] ?? state.balances[scope.accountId] === undefined
  );
  const rows = storedRows ?? EMPTY_ROWS;
  const livePrices = useWalletStore(state => state.tokenPrices);
  const pricesStatus = useWalletStore(state => state.tokenPricesStatus);
  const cachedPrices = useCachedDisplayQuotes();
  const tokenPrices = selectDisplayQuotes(livePrices, cachedPrices);
  const { isHidden, loaded: hiddenReady } = useHiddenTokens(scope.accountId);

  let held = false;
  const pricedRows: TokenBalanceData[] = [];
  const pricedValues: { tokenId: string; value: number }[] = [];
  let partial = false;
  // A held token the figure cannot value yet whose quote may still arrive: only it waits for the feed.
  let awaitingQuote = false;
  let staleQuote = false;
  let hasMarketValue = false;
  let usesCachedPrice = false;
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
      awaitingQuote ||= hasKnownScale(row.metadata) && quoteMayArrive(row.tokenId, row.metadata.symbol);
      continue;
    }
    const quoteAge = quote.observedAt === undefined ? Number.NaN : Date.now() - quote.observedAt;
    if (quote.kind !== 'fixed' && !(quoteAge >= 0 && quoteAge <= DISPLAY_QUOTE_MAX_AGE_MS)) {
      staleQuote = true;
      partial = true;
      unpriced.push(row.tokenId);
      awaitingQuote ||= quoteMayArrive(row.tokenId, row.metadata.symbol);
      continue;
    }
    staleQuote ||= quote.kind !== 'fixed' && quoteAge > CURRENT_MS;
    const value = row.balance * quote.price;
    if (!Number.isFinite(value)) {
      partial = true;
      unpriced.push(row.tokenId);
      continue;
    }
    hasMarketValue ||= quote.kind !== 'fixed';
    const liveQuote = tokenQuote(livePrices, row.tokenId, row.metadata.symbol);
    usesCachedPrice ||= quote !== liveQuote;
    pricedRows.push(row);
    pricedValues.push({ tokenId: row.tokenId, value });
    priced.push(row.tokenId);
  }
  const proof = storedRows === rows ? readBalanceSnapshot(rows, scope) : null;
  // This scope's last vault read, at any age: the figure shows it until the next read lands.
  const proofAge = proof?.capturedAt ? Date.now() - proof.capturedAt : Number.NaN;
  const proven = proofAge >= 0;
  const current = proven && proofAge <= CURRENT_MS;
  const { totalFiat: total, previousFiat } = valuedBalanceTotal(pricedRows, tokenPrices);
  const empty =
    proven && !isLoading && hiddenReady && rows.length > 0 && rows.every(row => row.balanceBaseUnits === '0');
  // Fixed quotes, tokens no quote can reach and a proven empty vault do not depend on the market feed.
  const canValueWithoutFeed = empty || (held && !awaitingQuote && !hasMarketValue);
  const value =
    proven &&
    hiddenReady &&
    // A fresh cached quote values the held tokens it covers, as the Sidebar total does; coverage says the rest are unpriced.
    (pricesStatus === 'ready' || canValueWithoutFeed || usesCachedPrice) &&
    (!held || pricedRows.length > 0)
      ? String(total)
      : null;
  const allocation =
    value !== null && !usesCachedPrice && !isLoading && Number.isFinite(total) && total > 0
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
    !usesCachedPrice &&
    marketPriced &&
    previousFiat > 0 &&
    Number.isFinite(move) &&
    Number.isFinite(percentage)
      ? { absolute: move, percentage }
      : null;
  const coverage: 'complete' | 'partial' = partial ? 'partial' : 'complete';
  return {
    assets: proven && hiddenReady ? assets : [],
    /** The rows an action may spend from: only a proof at most CURRENT_MS old, never the older one the figure shows. */
    actionBalances: current && hiddenReady ? assets : [],
    allocation,
    tokenPrices,
    livePrices,
    value,
    priceMovement24h,
    coverage,
    coverageKey: `priced:${priced.sort().join(',')}|unpriced:${unpriced.sort().join(',')}`,
    capturedAt: proof?.capturedAt,
    current: current && !isLoading,
    /** The rows can be shown: a proven read at any age, the one the figure shows. */
    shown: proven && !isLoading,
    empty,
    canRecord:
      current &&
      rows.length > 0 &&
      !isLoading &&
      hiddenReady &&
      pricesStatus === 'ready' &&
      !staleQuote &&
      !usesCachedPrice &&
      value !== null
  };
}
