import { canonicalFaucetId } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { fixedQuote } from 'lib/prices/fixed';
import { readCachedUsdPrice, toPriceMicro } from 'lib/prices/usd';

import { readVaultHoldings } from './vault-read';
import { ITransaction, ITransactionStatus } from '../db/types';
import { appendPositionEvents, type PositionEvent, type PositionQuote } from '../position-events';
import * as Repo from '../repo';
import { identifyValuedAsset, loadValuationContext } from '../spending-limits/valuation';

const OUTGOING_TYPES: ReadonlySet<string> = new Set(['send', 'swap', 'bridged-send', 'earn-deposit']);

type Flow = { arrived: bigint; departed: bigint };

/** What a completed row moved, per canonical faucet. Value its effects only where the row records them. */
export function rowFlows(row: ITransaction): Map<string, Flow> {
  const flows = new Map<string, Flow>();
  const add = (faucetId: string | undefined, amount: bigint | undefined, side: keyof Flow) => {
    if (!faucetId || typeof amount !== 'bigint' || amount <= 0n) return;
    const key = canonicalFaucetId(faucetId);
    const flow = flows.get(key) ?? { arrived: 0n, departed: 0n };
    flow[side] += amount;
    flows.set(key, flow);
  };
  if (row.type === 'consume') {
    if (row.assetTotals?.length) for (const total of row.assetTotals) add(total.faucetId, total.amount, 'arrived');
    else add(row.faucetId, row.amount, 'arrived');
  } else if (OUTGOING_TYPES.has(row.type)) {
    add(row.faucetId, row.amount, 'departed');
  }
  // A fee leaves in the fee asset; it is never part of the cost of what was sent.
  add(row.feeFaucetId, row.feeAmount, 'departed');
  return flows;
}

/** The quote that priced `priceSymbol` at completion: the fixed one, else the cached market price as stored. */
async function quoteAt(priceSymbol: string): Promise<PositionQuote | null> {
  const fixed = fixedQuote(priceSymbol);
  const fixedMicro = fixed && toPriceMicro(fixed.price);
  if (fixedMicro) return { priceMicro: fixedMicro, kind: 'fixed' };
  const cached = await readCachedUsdPrice(priceSymbol);
  return cached ? { priceMicro: cached.priceMicro, kind: 'market', observedAt: cached.fetchedAt * 1000 } : null;
}

/**
 * Records what a mainnet transaction that just completed did to the account's positions. It never fetches a price
 * (a quote fetched after the event cannot price it) and never throws: a failure leaves the position to read unknown.
 */
export async function recordPositionEvents(txId: string): Promise<void> {
  try {
    const network = getEffectiveNetworkName();
    if (network !== MIDEN_NETWORK_NAME.MAINNET) return;
    const row = await Repo.transactions.where({ id: txId }).first();
    if (!row || row.status !== ITransactionStatus.Completed || row.restoredFromBackup || row.recovered) return;
    const { completedAt } = row;
    if (typeof completedAt !== 'number' || !Number.isSafeInteger(completedAt)) return;
    const flows = rowFlows(row);
    if (flows.size === 0) return;
    const held = await readVaultHoldings(row.accountId, 'position-record');
    let context: Awaited<ReturnType<typeof loadValuationContext>> | undefined;
    try {
      context = await loadValuationContext(txId);
    } catch {
      context = undefined;
    }
    const events: PositionEvent[] = [];
    for (const [faucetId, flow] of flows) {
      let decimals: number | null = null;
      let quote: PositionQuote | null = null;
      if (context && flow.arrived > 0n) {
        try {
          const asset = await identifyValuedAsset(faucetId, context);
          decimals = asset.decimals;
          if (asset.priceSymbol !== undefined) quote = await quoteAt(asset.priceSymbol);
        } catch {
          // Unidentified: the arrival stays unpriced.
        }
      }
      events.push({
        key: `${txId}:${faucetId}`,
        txId,
        accountId: row.accountId,
        network,
        faucetId,
        eventAt: completedAt * 1000,
        ...flow,
        heldAfter: held === null ? null : (held.get(faucetId) ?? 0n),
        decimals,
        quote
      });
    }
    await appendPositionEvents(txId, events);
  } catch (error) {
    // A static message: amounts and ids stay out of logs.
    console.warn('[position] recording failed (non-fatal)', error instanceof Error ? error.name : 'unknown');
  }
}
