import { formatAmountDisplay } from 'lib/i18n/amount-display';
import { formatBigInt } from 'lib/i18n/numbers';
import { compareAccountIds } from 'lib/miden/activity/utils';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import * as Repo from 'lib/miden/repo';
import { tokenQuote } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';

import { resolveAssetRef, resolveNicheTokenId, resolveRecipientRef, type RedactionMap } from './redactor';
import type { AiCompilerOutput, LedgerTimeWindow } from './schema';

export type LocalQueryCompilerOutput = Extract<AiCompilerOutput, { op: 'query_ledger' }>;

export interface LocalQueryRow {
  id: string;
  primaryText: string;
  secondaryText?: string;
}

export interface LocalQueryResult {
  query: LocalQueryCompilerOutput['query'];
  titleKey: string;
  summaryText: string;
  empty: boolean;
  rows: LocalQueryRow[];
}

export interface LocalQueryContext {
  accountId: string;
  balances: readonly TokenBalanceData[];
  tokenPrices: TokenPrices;
  map: RedactionMap;
  nowMs?: number;
  readAccountTransactions?: (accountId: string) => Promise<readonly ITransaction[]>;
}

async function defaultReadAccountTransactions(accountId: string): Promise<readonly ITransaction[]> {
  const all = await Repo.transactions.toArray();
  return all.filter(tx => compareAccountIds(tx.accountId, accountId));
}

function resolveWindowRangeMs(window: LedgerTimeWindow, nowMs: number): { startMs: number; endMs: number } {
  const now = new Date(nowMs);
  switch (window) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      return { startMs: start, endMs: nowMs };
    }
    case 'last_7d':
      return { startMs: nowMs - 7 * 24 * 60 * 60_000, endMs: nowMs };
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      return { startMs: start, endMs: nowMs };
    }
    case 'prev_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
      const end = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      return { startMs: start, endMs: end };
    }
    case 'all_time':
    default:
      return { startMs: 0, endMs: Number.POSITIVE_INFINITY };
  }
}

function matchAssetBalance(
  balances: readonly TokenBalanceData[],
  assetQuery: string | null,
  map: RedactionMap
): TokenBalanceData[] {
  if (!assetQuery) return [...balances];
  const nicheId = resolveNicheTokenId(assetQuery, map);
  if (nicheId) {
    return balances.filter(row => row.tokenId === nicheId);
  }
  const resolved = resolveAssetRef(assetQuery, map).trim().toLowerCase();
  return balances.filter(
    row =>
      row.tokenId.toLowerCase() === resolved ||
      row.metadata.symbol.trim().toLowerCase() === resolved ||
      row.metadata.name.trim().toLowerCase() === resolved
  );
}

function formatTokenBalance(row: TokenBalanceData): string {
  if (!hasKnownScale(row.metadata)) return row.metadata.symbol;
  if (row.balanceBaseUnits && /^\d+$/.test(row.balanceBaseUnits)) {
    return `${formatBigInt(BigInt(row.balanceBaseUnits), row.metadata.decimals)} ${row.metadata.symbol}`;
  }
  return `${formatAmountDisplay(row.balance, { minimumFractionDigits: 0, trimTrailingZeros: true })} ${row.metadata.symbol}`;
}

function isOutgoingTx(tx: ITransaction): boolean {
  return tx.type === 'send' || tx.type === 'bridged-send' || tx.type === 'earn-deposit';
}

function isIncomingTx(tx: ITransaction): boolean {
  return tx.type === 'consume' || tx.type === 'bridged-receive' || tx.type === 'earn-withdraw';
}

function txCounterparty(tx: ITransaction): string | undefined {
  if (tx.secondaryAccountId) return tx.secondaryAccountId;
  if (tx.type === 'bridged-send') return tx.extraInputs?.destinationAddress;
  if (tx.type === 'bridged-receive') return tx.extraInputs?.sourceAddress;
  return undefined;
}

function txTimestampMs(tx: ITransaction): number {
  const sec = tx.completedAt || tx.initiatedAt || 0;
  return sec > 1e12 ? sec : sec * 1000;
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

/**
 * Executes `query_ledger` intents 100% locally against on-device balances and
 * IndexedDB history. Neither raw balances nor transaction rows ever leave the device.
 */
export async function executeLocalLedgerQuery(
  output: LocalQueryCompilerOutput,
  ctx: LocalQueryContext
): Promise<LocalQueryResult> {
  if (output.query === 'balance') {
    const matched = matchAssetBalance(ctx.balances, output.asset, ctx.map).filter(
      row => row.balance > 0 || (output.asset !== null && row.balance >= 0)
    );
    if (matched.length === 0) {
      return {
        query: 'balance',
        titleKey: 'commandAiQueryBalanceTitle',
        summaryText: output.asset ? `${resolveAssetRef(output.asset, ctx.map).toUpperCase()}: 0` : '0.00 USD',
        empty: true,
        rows: []
      };
    }

    let totalUsd = 0;
    let allPriced = true;
    const rows: LocalQueryRow[] = matched.map(row => {
      const formatted = formatTokenBalance(row);
      const quote = tokenQuote(ctx.tokenPrices, row.tokenId, row.metadata.symbol);
      const usd =
        quote && quote.kind !== 'nominal' && Number.isFinite(quote.price) && quote.price > 0
          ? row.balance * quote.price
          : null;
      if (usd !== null) totalUsd += usd;
      else allPriced = false;
      return {
        id: row.tokenId,
        primaryText: formatted,
        secondaryText:
          usd !== null
            ? `${formatAmountDisplay(usd, { minimumFractionDigits: 2, trimTrailingZeros: false })} USD`
            : undefined
      };
    });

    const summaryText =
      output.asset && matched.length === 1
        ? rows[0]!.secondaryText
          ? `${rows[0]!.primaryText} (${rows[0]!.secondaryText})`
          : rows[0]!.primaryText
        : allPriced
          ? `${formatAmountDisplay(totalUsd, { minimumFractionDigits: 2, trimTrailingZeros: false })} USD`
          : rows
              .slice(0, 3)
              .map(r => r.primaryText)
              .join(' · ');

    return {
      query: 'balance',
      titleKey: 'commandAiQueryBalanceTitle',
      summaryText,
      empty: false,
      rows: rows.slice(0, 5)
    };
  }

  const nowMs = ctx.nowMs ?? Date.now();
  const { startMs, endMs } = resolveWindowRangeMs(output.window, nowMs);
  const reader = ctx.readAccountTransactions ?? defaultReadAccountTransactions;
  const allTxs = await reader(ctx.accountId);

  const resolvedCounterparty = output.counterparty_ref
    ? resolveRecipientRef(output.counterparty_ref, ctx.map)
    : undefined;
  const targetAddress =
    resolvedCounterparty?.kind === 'contact'
      ? resolvedCounterparty.contact.address.toLowerCase()
      : resolvedCounterparty?.kind === 'addr'
        ? resolvedCounterparty.raw.toLowerCase()
        : undefined;

  const targetFaucets = new Set(
    output.asset ? matchAssetBalance(ctx.balances, output.asset, ctx.map).map(b => b.tokenId.toLowerCase()) : []
  );

  const filtered = allTxs
    .filter(tx => {
      if (tx.status === ITransactionStatus.Failed) return false;
      const ts = txTimestampMs(tx);
      if (ts < startMs || ts >= endMs) return false;
      if (output.direction === 'out' && !isOutgoingTx(tx)) return false;
      if (output.direction === 'in' && !isIncomingTx(tx)) return false;
      if (targetAddress) {
        const cp = txCounterparty(tx)?.toLowerCase();
        if (!cp || cp !== targetAddress) return false;
      }
      if (output.asset) {
        const moves = txAssetMoves(tx);
        const matches = moves.some(move => targetFaucets.has(move.faucetId.toLowerCase()));
        if (!matches) return false;
      }
      return true;
    })
    .sort((a, b) => txTimestampMs(b) - txTimestampMs(a));

  if (filtered.length === 0) {
    return {
      query: output.query,
      titleKey: output.query === 'tx_sum' ? 'commandAiQueryTotalTitle' : 'commandAiQueryHistoryTitle',
      summaryText: '0',
      empty: true,
      rows: []
    };
  }

  const byFaucet = new Map<string, bigint>();
  const balanceById = new Map(ctx.balances.map(b => [b.tokenId.toLowerCase(), b]));

  for (const tx of filtered) {
    for (const move of txAssetMoves(tx)) {
      if (output.asset && !targetFaucets.has(move.faucetId.toLowerCase())) continue;
      const key = move.faucetId.toLowerCase();
      byFaucet.set(key, (byFaucet.get(key) ?? 0n) + move.amount);
    }
  }

  const totalsSummary = [...byFaucet.entries()]
    .map(([faucetKey, sum]) => {
      const meta = balanceById.get(faucetKey)?.metadata;
      if (meta && hasKnownScale(meta)) {
        return `${formatBigInt(sum, meta.decimals)} ${meta.symbol}`;
      }
      return sum.toString();
    })
    .join(' + ');

  const rows: LocalQueryRow[] = filtered.slice(0, 5).map(tx => {
    const move = txAssetMoves(tx)[0];
    const meta = move ? balanceById.get(move.faucetId.toLowerCase())?.metadata : undefined;
    const amountText =
      move && meta && hasKnownScale(meta)
        ? `${formatBigInt(move.amount, meta.decimals)} ${meta.symbol}`
        : move
          ? move.amount.toString()
          : tx.type;
    const dateText = new Date(txTimestampMs(tx)).toLocaleDateString();
    return {
      id: tx.id,
      primaryText: `${tx.type} · ${amountText}`,
      secondaryText: dateText
    };
  });

  return {
    query: output.query,
    titleKey: output.query === 'tx_sum' ? 'commandAiQueryTotalTitle' : 'commandAiQueryHistoryTitle',
    summaryText: totalsSummary || String(filtered.length),
    empty: false,
    rows
  };
}
