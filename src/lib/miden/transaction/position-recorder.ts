import { canonicalFaucetId } from 'lib/miden/swap/tokens';
import { provenBadgeNetwork } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { fixedQuote } from 'lib/prices/fixed';
import { readCachedUsdPrice, toPriceMicro } from 'lib/prices/usd';

import { readVaultHoldings } from './vault-read';
import { ITransaction, ITransactionStatus } from '../db/types';
import { appendPositionEvents, type PositionEvent, type PositionQuote } from '../position-events';
import * as Repo from '../repo';
import { identifyValuedAsset, loadValuationContext } from '../spending-limits/valuation';

const OUTGOING_TYPES: ReadonlySet<string> = new Set(['send', 'swap', 'bridged-send', 'earn-deposit', 'register-name']);

export const POSITION_PRICE_DEADLINE_MS = 2000;

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
  } else if (row.type === 'execute') {
    for (const total of row.spentAssetTotals ?? []) add(total.faucetId, total.amount, 'departed');
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
export async function recordPositionEvents(txId: string, options: { anchor?: boolean } = {}): Promise<void> {
  try {
    const network = provenBadgeNetwork();
    if (network !== MIDEN_NETWORK_NAME.MAINNET) return;
    if ((await Repo.positionEvents.where('txId').equals(txId).count()) > 0) return;
    const row = await Repo.transactions.where({ id: txId }).first();
    if (!row || row.status !== ITransactionStatus.Completed || row.restoredFromBackup || row.recovered) return;
    const { completedAt } = row;
    if (typeof completedAt !== 'number' || !Number.isSafeInteger(completedAt)) return;
    const flows = rowFlows(row);
    if (flows.size === 0) return;
    const held = options.anchor === false ? null : await readVaultHoldings(row.accountId, 'position-record');
    const arrivals = [...flows].filter(([, flow]) => flow.arrived > 0n);
    let pricing = new Map<string, { decimals: number; quote: PositionQuote | null }>();
    if (arrivals.length > 0) {
      const priceArrivals = async () => {
        const context = await loadValuationContext(txId);
        const values = new Map<string, { decimals: number; quote: PositionQuote | null }>();
        for (const [faucetId] of arrivals) {
          try {
            const asset = await identifyValuedAsset(faucetId, context);
            let quote: PositionQuote | null = null;
            if (asset.priceSymbol !== undefined) quote = await quoteAt(asset.priceSymbol);
            values.set(faucetId, { decimals: asset.decimals, quote });
          } catch {
            // This arrival stays unpriced; continue pricing the rest of the row.
          }
        }
        return values;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), POSITION_PRICE_DEADLINE_MS);
      });
      // Convert rejection into a settled result so a timeout cannot leave a rejection unhandled.
      const work = priceArrivals().then(
        values => ({ kind: 'priced' as const, values }),
        () => ({ kind: 'failed' as const })
      );
      const result = await Promise.race([work, timeout]);
      if (result.kind !== 'timeout' && timer !== undefined) clearTimeout(timer);
      if (result.kind === 'priced') pricing = result.values;
    }
    const events: PositionEvent[] = [];
    for (const [faucetId, flow] of flows) {
      const priced = pricing.get(faucetId);
      events.push({
        key: `${txId}:${faucetId}`,
        txId,
        accountId: row.accountId,
        network,
        faucetId,
        eventAt: completedAt * 1000,
        ...flow,
        heldAfter: held === null ? null : (held.get(faucetId) ?? 0n),
        decimals: priced?.decimals ?? null,
        quote: priced?.quote ?? null
      });
    }
    await appendPositionEvents(txId, events);
  } catch (error) {
    // A static message: amounts and ids stay out of logs.
    console.warn('[position] recording failed (non-fatal)', error instanceof Error ? error.name : 'unknown');
  }
}
