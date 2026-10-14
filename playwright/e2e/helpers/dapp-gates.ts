import { isDeepStrictEqual } from 'node:util';

import type { VaultReading } from './balance-truth';

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

/** A sync of the store's current account, published with a stamp after `sinceMs`. */
export const syncedSince = (reading: VaultReading, sinceMs: number): boolean =>
  reading.sync !== null && reading.sync.account === reading.storeAccount && reading.sync.syncedAtMs > sinceMs;

/**
 * Whether the store's vault is one a sync of its current account stamped after `sinceMs` published. The service worker
 * reads the vault it publishes after the stamp (sync-manager.ts:258-260, 417-533), and a row completes only after its
 * transaction was applied, so that vault holds every transaction the account completed before `sinceMs`.
 */
export const storeHoldsSyncSince = (reading: VaultReading, sinceMs: number): boolean =>
  syncedSince(reading, sinceMs) && isDeepStrictEqual(reading.store, reading.sync?.vault);

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

/** What the quiesce reads to decide whether a dApp already holds the session a cell wants. */
export interface SessionCheck {
  adapterConnected: boolean;
  adapterAddress: string | null;
  providerAddress: string | null;
  privateDataPermission: string | null;
  /** The accounts the wallet's own session store holds for the dApp's origin. */
  walletSessionAccounts: readonly string[];
}

/**
 * Whether the dApp is connected as `account` with `permission`, by the page and by the wallet. The page alone is not
 * enough: the provider learns of a wallet-side revoke only from its 10 s poll (client.ts:68-87), so for up to that long
 * it still reports the revoked account, and a request made then is refused before any popup.
 */
export function sessionHeld(state: SessionCheck, account: string, permission: string): boolean {
  const same = (address: string | null) => address !== null && canonicalAddress(address) === canonicalAddress(account);
  return (
    state.adapterConnected &&
    same(state.adapterAddress) &&
    same(state.providerAddress) &&
    state.privateDataPermission === permission &&
    state.walletSessionAccounts.some(same)
  );
}

/**
 * `open`, run once and its promise shared by every caller (a journey's second dApp, B's dApp), until it rejects: a
 * failed open, such as a node failure in the dApp's init, belongs to the cells that waited on it, so the next caller
 * opens again instead of failing on a rejection kept from an earlier cell.
 */
export function sharedOpen<T>(open: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending === undefined) {
      const started = open();
      pending = started;
      started.catch(() => (pending = undefined));
    }
    return pending;
  };
}

/** The fields of a wallet transaction row the stale-authorization cells (M3, M9) read. */
export interface RanRow {
  type?: string;
  accountId?: string;
}

/**
 * Whether a stale consume executed: something ran, and every row that ran is a consume of the stale account. A row for
 * any other account, of another type or naming no account is a different failure.
 */
export function onlyStaleConsumesRan(ran: readonly RanRow[], staleAccount: string): boolean {
  return (
    ran.length > 0 &&
    ran.every(
      row =>
        row.type === 'consume' &&
        row.accountId !== undefined &&
        canonicalAddress(row.accountId) === canonicalAddress(staleAccount)
    )
  );
}

/** One read M4-reads made as a session's account while the other account was current. */
export interface NonCurrentRead {
  prompted: boolean;
  result: { ok: true } | { ok: false; error: { message: string } };
  /** The vault the answer served, as `{ faucetId: amount }`, or null when it served none. */
  served: Record<string, string> | null;
  /** The session account's own vault. */
  own: Record<string, string>;
}

/**
 * The evidence for M4-reads. A read stays on its session's account when it was refused before any popup with
 * NOT_GRANTED (Q10) or, after a popup, served exactly that account's vault. A read served with no popup, an
 * approval that then failed and another account's vault are neither, so the cell stays a new failure.
 */
export function nonCurrentReadEvidence(reads: readonly NonCurrentRead[]): {
  nonCurrentPrompted: boolean;
  nonCurrentReadsOwnOrRefused: boolean;
} {
  return {
    nonCurrentPrompted: reads.some(read => read.prompted),
    nonCurrentReadsOwnOrRefused: reads.every(read =>
      read.prompted
        ? read.served !== null && isDeepStrictEqual(read.served, read.own)
        : !read.result.ok && read.result.error.message === 'NOT_GRANTED'
    )
  };
}

/**
 * Whether a note's sender is the journey: one of `journeySenders` (both wallets' accounts, the CLI faucet, the public
 * faucet), by address part. A sender the wallet did not record counts as the journey, so a missing record can never
 * turn a wallet failure into the environment's.
 */
export function isJourneySender(sender: string | undefined, journeySenders: readonly string[]): boolean {
  if (sender === undefined || sender === '') return true;
  const address = canonicalAddress(sender).toLowerCase();
  return journeySenders.some(known => canonicalAddress(known).toLowerCase() === address);
}

/** The fields of a wallet row that say whether it consumed a third party's note. */
export interface ConsumeRowFacts {
  id: string;
  type?: string;
  /** On a consume row, the sender of its first note (`ConsumeTransaction`); on a send, the recipient. */
  secondaryAccountId?: string;
}

/**
 * A consume of a note no one in the journey sent. Any account can be sent one once its id is on chain, and the
 * wallet's native auto-consume takes it (sync-manager.ts:598-660), so it is the environment acting, never the cell.
 */
export function isForeignConsume(row: ConsumeRowFacts, journeySenders: readonly string[]): boolean {
  return row.type === 'consume' && !isJourneySender(row.secondaryAccountId, journeySenders);
}

/** An account's assets as `{ faucetId: amount }`, so two views compare with one `toEqual` whatever their row order. */
export function assetMap(assets: readonly { faucetId: string; amount: string | bigint }[]): Record<string, string> {
  const totals = new Map<string, bigint>();
  for (const asset of assets) totals.set(asset.faucetId, (totals.get(asset.faucetId) ?? 0n) + BigInt(asset.amount));
  return Object.fromEntries(
    [...totals].filter(([, amount]) => amount !== 0n).map(([id, amount]) => [id, amount.toString()])
  );
}
