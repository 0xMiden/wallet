/**
 * The Activity tab's Groups view: one row per counterparty or category, derived from the history
 * entries already loaded.
 *
 * Purely a function of the entries handed in — no store, no fetch, no persistence of its own. The
 * page loads history a page at a time (see `History`), so this runs again on every page that
 * lands and the groups simply grow; that is also why a count here is a count of what is LOADED,
 * never of what exists (see `ActivityGroup.count`).
 */

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { isFaucetRequest } from './transactionUtils';

/**
 * What a group is keyed by:
 *
 * - `address` — a person or an address: sends and receives keyed by the counterparty.
 * - `swap` — every swap, whatever the pair.
 * - `faucet` — faucet claims.
 * - `guardian` — `switch-guardian` and `replace-hot-key`, the wallet's own "system" row.
 * - `other` — everything with no counterparty and no category of its own (an `execute`, an earn
 *   leg). A catch-all rather than a drop: a row the feed lists has to be reachable from the
 *   grouped view too, or the two views disagree about what happened.
 */
export type ActivityGroupKind = 'address' | 'swap' | 'faucet' | 'guardian' | 'other';

/** The category groups, in the order they are keyed. `address` is not here: it carries an id. */
export const ACTIVITY_GROUP_KINDS: readonly ActivityGroupKind[] = ['address', 'swap', 'faucet', 'guardian', 'other'];

export interface ActivityGroupKey {
  kind: ActivityGroupKind;
  /** The counterparty address for `address`; the kind's own name for every category group. */
  id: string;
}

export interface ActivityGroup extends ActivityGroupKey {
  /** The group's entries, in the order the feed lists them (in flight first, then newest first). */
  entries: IHistoryEntry[];
  /** How many entries are in the group — of what is LOADED. See the module comment. */
  count: number;
  /** How many of them are still in flight, which is what the row's pending badge reports. */
  pendingCount: number;
  /** The newest entry, which the row renders as its subtitle. */
  latest: IHistoryEntry;
  /** `latest`'s timestamp, or `-Infinity` when no entry in the group carries a usable one. */
  latestTimestamp: number;
  /** The contact's or account's name, when the address matches one. `address` groups only. */
  name?: string;
}

/** Resolves a counterparty address to a contact's or an own account's name, or `undefined`. */
export type ActivityCounterpartyName = (address: string) => string | undefined;

/** An entry the wallet has queued or is generating: the rows the pending badge counts. */
export function isPendingActivityEntry(entry: IHistoryEntry): boolean {
  return entry.type === HistoryEntryType.PendingTransaction || entry.type === HistoryEntryType.ProcessingTransaction;
}

/** A timestamp a `Date` can be built from; `-Infinity` for anything else, so it never wins a max. */
function usableTimestamp(entry: IHistoryEntry): number {
  return Number.isFinite(entry.timestamp) ? entry.timestamp : -Infinity;
}

/**
 * Which group an entry belongs to. The order is the point: a faucet claim's counterparty IS the
 * faucet id, and a guardian switch and a swap both carry addresses of their own, so each category
 * has to be decided before the address fallback can claim it.
 */
export function activityGroupKeyOf(entry: IHistoryEntry): ActivityGroupKey {
  if (entry.txType === 'switch-guardian' || entry.txType === 'replace-hot-key') {
    return { kind: 'guardian', id: 'guardian' };
  }
  if (entry.txType === 'swap') return { kind: 'swap', id: 'swap' };
  if (isFaucetRequest(entry)) return { kind: 'faucet', id: 'faucet' };
  const address = entry.secondaryAddress?.trim();
  if (address) return { kind: 'address', id: address };
  return { kind: 'other', id: 'other' };
}

/**
 * Two addresses that differ only in case are one counterparty: a `0x` address is routinely
 * written both ways, and the address book stores whichever the user pasted.
 */
function addressBucket(key: ActivityGroupKey): string {
  return key.kind === 'address' ? `address:${key.id.toLowerCase()}` : key.kind;
}

/**
 * Groups the loaded history entries, newest group first.
 *
 * `nameOf` is consulted once per group, not once per entry: it is the address book plus the
 * user's own accounts, and a group either matches one or shows its truncated address.
 */
export function groupActivityEntries(
  entries: readonly IHistoryEntry[],
  nameOf: ActivityCounterpartyName = () => undefined
): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();

  for (const entry of entries) {
    const key = activityGroupKeyOf(entry);
    const bucket = addressBucket(key);
    const timestamp = usableTimestamp(entry);
    const existing = groups.get(bucket);

    if (!existing) {
      groups.set(bucket, {
        ...key,
        entries: [entry],
        count: 1,
        pendingCount: isPendingActivityEntry(entry) ? 1 : 0,
        latest: entry,
        latestTimestamp: timestamp,
        name: key.kind === 'address' ? nameOf(key.id) : undefined
      });
      continue;
    }

    existing.entries.push(entry);
    existing.count += 1;
    if (isPendingActivityEntry(entry)) existing.pendingCount += 1;
    // `>`, not `>=`: the feed hands entries over newest first, so the first entry at a given
    // timestamp is the one the feed itself treats as newest (its secondary sort is the entry
    // type), and a later one must not displace it.
    if (timestamp > existing.latestTimestamp) {
      existing.latest = entry;
      existing.latestTimestamp = timestamp;
    }
  }

  // Newest group first, then by id so a lap that loads no new entry never reshuffles the list.
  return [...groups.values()].sort((a, b) => b.latestTimestamp - a.latestTimestamp || a.id.localeCompare(b.id));
}

/**
 * The predicate the group's own page hands to `History`, so that page is the same list as the
 * feed, narrowed — infinite scroll, the in-flight rows and the row rendering all come with it.
 */
export function activityGroupMatcher(kind: ActivityGroupKind, id?: string): (entry: IHistoryEntry) => boolean {
  const wanted = kind === 'address' ? id?.trim().toLowerCase() : undefined;
  return entry => {
    const key = activityGroupKeyOf(entry);
    if (key.kind !== kind) return false;
    return kind === 'address' ? key.id.toLowerCase() === wanted : true;
  };
}

/** The route of a group's page. A category group needs no id; an address carries one. */
export function activityGroupPath(key: ActivityGroupKey): string {
  return key.kind === 'address'
    ? `/activity/group/address/${encodeURIComponent(key.id)}`
    : `/activity/group/${key.kind}`;
}

/** Narrows a route's `:kind` param, so an unknown path can redirect instead of rendering nothing. */
export function isActivityGroupKind(value: string | undefined): value is ActivityGroupKind {
  return ACTIVITY_GROUP_KINDS.some(kind => kind === value);
}
