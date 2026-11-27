import { compareAccountIds } from 'lib/miden/activity/utils';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import type { PortfolioObservation } from 'lib/miden/portfolio-observations';
import { tokenQuote } from 'lib/miden/swap/tokens';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import type { TokenPrices } from 'lib/prices';

const BUCKET_MS = 15 * 60_000;

function txDirection(type: ITransaction['type']): 1 | -1 | 0 {
  switch (type) {
    case 'consume':
    case 'bridged-receive':
    case 'earn-withdraw':
      return 1;
    case 'send':
    case 'bridged-send':
    case 'earn-deposit':
      return -1;
    default:
      return 0;
  }
}

function txTimestampMs(tx: ITransaction): number {
  const raw = tx.completedAt || tx.initiatedAt || 0;
  return raw > 1e12 ? raw : raw * 1000;
}

function txAssetMoves(tx: ITransaction): Array<{ faucetId: string; amount: bigint }> {
  if (tx.faucetId && typeof tx.amount === 'bigint' && tx.amount > 0n) {
    return [{ faucetId: tx.faucetId, amount: tx.amount }];
  }
  if (tx.assetTotals && tx.assetTotals.length > 0) {
    return tx.assetTotals.filter(item => item.amount > 0n);
  }
  return [];
}

function priceForAsset(asset: TokenBalanceData, tokenPrices: TokenPrices): number {
  const quote = tokenQuote(tokenPrices, asset.tokenId, asset.metadata.symbol);
  if (quote && quote.kind !== 'nominal' && Number.isFinite(quote.price) && quote.price > 0) {
    return quote.price;
  }
  return asset.fiatPrice > 0 && Number.isFinite(asset.fiatPrice) ? asset.fiatPrice : 0;
}

/**
 * Reconstruct chronological USD portfolio balance points by walking backwards from the
 * current live balance across completed priced transactions for the active account.
 */
export function buildActivityHistoryObservations({
  scope,
  transactions,
  assets,
  tokenPrices,
  currentValue,
  coverage,
  coverageKey
}: {
  scope: AccountScope;
  transactions: readonly ITransaction[];
  assets: readonly TokenBalanceData[];
  tokenPrices: TokenPrices;
  currentValue: string | null;
  coverage: 'complete' | 'partial';
  coverageKey: string;
}): PortfolioObservation[] {
  if (currentValue === null) return [];
  const liveUsd = Number(currentValue);
  if (!Number.isFinite(liveUsd)) return [];

  const priced: Array<{ id: string; ts: number; deltaUsd: number }> = [];
  for (const tx of transactions) {
    if (tx.status !== ITransactionStatus.Completed) continue;
    if (!compareAccountIds(tx.accountId, scope.accountId)) continue;
    const sign = txDirection(tx.type);
    if (sign === 0) continue;
    const ts = txTimestampMs(tx);
    if (ts <= 0) continue;

    let moveUsd = 0;
    for (const move of txAssetMoves(tx)) {
      const asset = assets.find(
        item =>
          compareAccountIds(item.tokenId, move.faucetId) || item.tokenId.toLowerCase() === move.faucetId.toLowerCase()
      );
      if (!asset || !hasKnownScale(asset.metadata)) continue;
      const price = priceForAsset(asset, tokenPrices);
      if (price <= 0) continue;
      const units = Number(move.amount) / 10 ** asset.metadata.decimals;
      if (Number.isFinite(units) && units > 0) {
        moveUsd += units * price;
      }
    }

    const deltaUsd = sign * moveUsd;
    if (Number.isFinite(deltaUsd) && deltaUsd !== 0) {
      priced.push({ id: tx.id, ts, deltaUsd });
    }
  }

  if (priced.length < 2) return [];
  priced.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.id.localeCompare(b.id)));

  let running = liveUsd;
  const rawPoints: Array<{ ts: number; value: number }> = new Array(priced.length);
  for (let i = priced.length - 1; i >= 0; i -= 1) {
    const entry = priced[i]!;
    rawPoints[i] = { ts: entry.ts, value: Math.max(0, running) };
    running = Math.max(0, running - entry.deltaUsd);
  }

  const firstTs = priced[0]!.ts;
  const lastTs = priced[priced.length - 1]!.ts;
  const span = Math.max(0, lastTs - firstTs);
  const leadMs = span > 0 ? Math.max(1_000, Math.round(span * 0.03)) : 60_000;
  const series: Array<{ ts: number; value: number }> = [
    { ts: Math.max(1, firstTs - leadMs), value: Math.max(0, running) },
    ...rawPoints
  ];

  return series.map((point, index) => ({
    ...scope,
    currency: 'USD',
    capturedAt: point.ts,
    bucket: index * BUCKET_MS,
    value: point.value.toFixed(2),
    coverage,
    coverageKey
  }));
}
