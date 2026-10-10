/** Pure decisions the dApp driver makes, kept free of Playwright and the wallet page so Jest can pin them. */

export interface FreshSyncOptions {
  readSyncedAt(): Promise<number | null>;
  triggerSync(): Promise<void>;
  /** When the dApp observed its target height. */
  sinceMs: number;
  required?: number;
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolves once the wallet has completed `required` distinct syncs stamped after `sinceMs`. One fresh stamp is not
 * enough: a sync that started before the dApp reached its height can finish after it and still have synced to less.
 */
export async function waitForFreshSyncs(options: FreshSyncOptions): Promise<number[]> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const required = options.required ?? 2;
  const started = now();
  const seen: number[] = [];
  let last: number | null = null;
  for (;;) {
    await options.triggerSync();
    last = await options.readSyncedAt();
    if (last !== null && last > options.sinceMs && !seen.includes(last)) seen.push(last);
    if (seen.length >= required) return seen;
    if (now() - started >= options.timeoutMs) {
      throw new Error(
        `wallet sync gate: ${seen.length} of ${required} syncs completed after ${options.sinceMs} ` +
          `within ${options.timeoutMs}ms (last stamp ${last})`
      );
    }
    await sleep(options.pollMs ?? 1_000);
  }
}

export interface ConfirmPageEvent {
  type: 'open' | 'close';
  at: number;
  url: string;
  origin: string | null;
}

/** The most confirm.html pages open at once over a recorded window; the wallet's one queue keeps it at 1. */
export function maxConcurrentConfirmPages(events: readonly ConfirmPageEvent[]): number {
  let open = 0;
  let max = 0;
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    open += event.type === 'open' ? 1 : -1;
    max = Math.max(max, open);
  }
  return max;
}

export const normalizeHex = (value: string): string => value.toLowerCase().replace(/^0x/, '');

/** The wallet stores some accounts under a composite `<address>_<suffix>` key; compare the address part. */
export const canonicalAddress = (address: string): string => address.split('_')[0] ?? address;

/** An account's assets as `{ faucetId: amount }`, so two views compare with one `toEqual` whatever their row order. */
export function assetMap(assets: readonly { faucetId: string; amount: string | bigint }[]): Record<string, string> {
  const totals = new Map<string, bigint>();
  for (const asset of assets) totals.set(asset.faucetId, (totals.get(asset.faucetId) ?? 0n) + BigInt(asset.amount));
  return Object.fromEntries(
    [...totals].filter(([, amount]) => amount !== 0n).map(([id, amount]) => [id, amount.toString()])
  );
}
