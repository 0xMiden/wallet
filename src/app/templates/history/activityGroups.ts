/**
 * The Activity tab's Groups view: one row per counterparty or category, derived from the history
 * entries already loaded.
 *
 * Purely a function of the entries handed in — no store, no fetch, no persistence of its own. The
 * page loads history a page at a time (see `History`), so this runs again on every page that
 * lands and the groups simply grow; that is also why a count here is a count of what is LOADED,
 * never of what exists (see `ActivityGroup.count`).
 */

import type { ITransactionType } from 'lib/miden/db/types';
import { canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import type { PendingActivityItem } from './PendingActivityCard';
import { isFaucetRequest, networkHasFaucetClaims } from './transactionUtils';

/**
 * The category chips of the Activity feed (Transfer, Swap, Earn, Others). Each transaction type
 * is in one category only.
 */
export type ActivityCategory = 'transfer' | 'swap' | 'earn' | 'others';

/**
 * The category of an activity row. It reads the transaction type, not the icon: a failed row
 * shows the FAILED icon, but it stays in the category of its type.
 *
 * The switch has a case for each `ITransactionType` and no default. Thus a new type does not
 * compile until it gets a category, and no row can go missing from every chip.
 */
export function activityCategoryOf(entry: { txType: ITransactionType }): ActivityCategory {
  switch (entry.txType) {
    case 'send':
    case 'consume':
    case 'bridged-send':
    case 'bridged-receive':
      return 'transfer';
    case 'swap':
      return 'swap';
    case 'earn-deposit':
    case 'earn-withdraw':
      return 'earn';
    case 'execute':
    case 'switch-guardian':
    case 'replace-hot-key':
    case 'update-procedure-threshold':
      return 'others';
  }
}

/**
 * Whether a claimable note is a faucet claim. Its consume row copies the note's faucet and sender
 * (`ConsumeTransaction`), so this is `isFaucetRequest` on those two values: a note of the native
 * asset sent by the native faucet, on a network that has a faucet (`networkHasFaucetClaims`); on
 * Mainnet that faucet is the USDCx minter, so the note is an ordinary receive there.
 */
export function isFaucetClaimNote(
  note: { faucetId: string; senderAddress: string },
  nativeFaucetId: string | null = getNativeAssetIdSync()
): boolean {
  if (!networkHasFaucetClaims(getEffectiveNetworkName())) return false;
  return !!nativeFaucetId && note.faucetId === nativeFaucetId && note.senderAddress === nativeFaucetId;
}

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

/** The i18n key naming each category group, on its row in the list and as its page's heading. */
export const ACTIVITY_GROUP_LABELS: Record<Exclude<ActivityGroupKind, 'address'>, string> = {
  swap: 'activityGroupSwaps',
  faucet: 'activityGroupFaucet',
  guardian: 'activityGroupGuardian',
  other: 'activityGroupOther'
};

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
  /** The newest transaction when it is newer than or tied with the visible claims. */
  latest?: IHistoryEntry;
  /** Visible claim cards that represent an incoming transfer until the claim settles. */
  claims: PendingActivityItem[];
  /** The latest activity timestamp, or `-Infinity` when none is available. */
  latestTimestamp: number;
  /** The contact's or account's name, when the address matches one. `address` groups only. */
  name?: string;
}

/** Resolves a counterparty address to a contact's or an own account's name, or `undefined`. */
export type ActivityCounterpartyName = (address: string, knownKey?: string) => string | undefined;

/**
 * Counterparty text (trimmed, lowercased) to its activity key, for one mounted wallet account.
 * The list and the group page each keep their own map. Nothing here retains one across mounts.
 */
export type ActivityKeyMemory = Map<string, string>;

const MIDEN_ACCOUNT_HEX = /^0x[0-9a-f]{30}$/i;

function activityCounterpartyText(address: string): string {
  return address.trim().toLowerCase();
}

function activityCounterpartyKey(address: string, activityKeys?: ActivityKeyMemory, seen?: Set<string>): string {
  const fallback = activityCounterpartyText(address);
  seen?.add(fallback);
  const suffix = fallback.indexOf('_');
  if (fallback.startsWith('0x') && (suffix < 0 || !MIDEN_ACCOUNT_HEX.test(fallback.slice(0, suffix)))) {
    return fallback;
  }
  const remembered = activityKeys?.get(fallback);
  if (remembered !== undefined) return remembered;
  const canonical = canonicalWalletAccountId(fallback);
  // The SDK helper can fall back to a tag-stripped string when parsing fails.
  if (!MIDEN_ACCOUNT_HEX.test(canonical)) return fallback;
  const key = canonical.toLowerCase();
  activityKeys?.set(fallback, key);
  return key;
}

/** Drops remembered texts this pass did not keep. A non-hex parse fallback is never stored. */
export function retainActivityKeyMemory(activityKeys: ActivityKeyMemory, texts: Iterable<string>): void {
  const keep = new Set<string>();
  for (const text of texts) {
    const normalized = activityCounterpartyText(text);
    if (normalized) keep.add(normalized);
  }
  for (const text of activityKeys.keys()) {
    if (!keep.has(text)) activityKeys.delete(text);
  }
}

export function activityCounterpartyNames(
  contacts: readonly { address: string; name: string }[],
  activityKeys?: ActivityKeyMemory
): ActivityCounterpartyName {
  const names = new Map<string, string>();
  for (const contact of contacts) {
    const name = contact.name?.trim();
    if (!name) continue;
    const key = activityCounterpartyKey(contact.address);
    if (!names.has(key)) names.set(key, name);
  }
  return (address, knownKey) => names.get(knownKey ?? activityCounterpartyKey(address, activityKeys));
}

/** An entry the wallet has queued or is generating: the rows the pending badge counts. */
export function isPendingActivityEntry(entry: IHistoryEntry): boolean {
  return entry.type === HistoryEntryType.PendingTransaction || entry.type === HistoryEntryType.ProcessingTransaction;
}

/** A timestamp a `Date` can be built from; `-Infinity` for anything else, so it never wins a max. */
function usableTimestamp(timestamp = -Infinity): number {
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
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
  return activityAddressGroupKey(entry.secondaryAddress);
}

function activityAddressGroupKey(counterparty?: string): ActivityGroupKey {
  const address = counterparty?.trim();
  if (address) return { kind: 'address', id: address };
  return { kind: 'other', id: 'other' };
}

/**
 * Groups the loaded history entries, newest group first.
 *
 * `nameOf` is consulted once per group, not once per entry: it is the address book plus the
 * user's own accounts, and a group either matches one or shows its truncated address.
 *
 * `activityKeys`, when the mounted list supplies it, remembers the counterparties of this pass
 * and drops the rest. Callers that omit it resolve the keys on each pass.
 */
export function groupActivityEntries(
  entries: readonly IHistoryEntry[],
  nameOf: ActivityCounterpartyName = () => undefined,
  claims: readonly PendingActivityItem[] = [],
  activityKeys?: ActivityKeyMemory
): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  const seen = activityKeys ? new Set<string>() : undefined;

  const getGroup = (key: ActivityGroupKey): ActivityGroup => {
    const addressKey = key.kind === 'address' ? activityCounterpartyKey(key.id, activityKeys, seen) : undefined;
    const bucket = addressKey === undefined ? key.kind : `address:${addressKey}`;
    const existing = groups.get(bucket);
    if (existing) {
      if (existing.kind === 'address' && MIDEN_ACCOUNT_HEX.test(existing.id) && !MIDEN_ACCOUNT_HEX.test(key.id)) {
        existing.id = key.id;
      }
      return existing;
    }

    const group: ActivityGroup = {
      ...key,
      entries: [],
      count: 0,
      pendingCount: 0,
      claims: [],
      latestTimestamp: -Infinity,
      name: addressKey === undefined ? undefined : nameOf(key.id, addressKey)
    };
    groups.set(bucket, group);
    return group;
  };

  for (const entry of entries) {
    const group = getGroup(activityGroupKeyOf(entry));
    const timestamp = usableTimestamp(entry.timestamp);
    group.entries.push(entry);
    group.count += 1;
    if (isPendingActivityEntry(entry)) group.pendingCount += 1;
    // `>`, not `>=`: the feed hands entries over newest first, so the first entry at a given
    // timestamp is the one the feed itself treats as newest (its secondary sort is the entry
    // type), and a later one must not displace it.
    if (!group.latest || timestamp > group.latestTimestamp) {
      group.latest = entry;
      group.latestTimestamp = timestamp;
    }
  }

  for (const claim of claims) {
    const group = getGroup(activityClaimGroupKeyOf(claim.note));
    const timestamp = usableTimestamp(claim.note.receivedAt);
    group.claims.push(claim);
    if (timestamp > group.latestTimestamp) {
      group.latest = undefined;
      group.latestTimestamp = timestamp;
    }
  }

  if (activityKeys && seen) retainActivityKeyMemory(activityKeys, seen);

  // Newest group first, then by id so a lap that loads no new entry never reshuffles the list.
  return [...groups.values()].sort((a, b) => b.latestTimestamp - a.latestTimestamp || a.id.localeCompare(b.id));
}

/**
 * The predicate the group's own page hands to `History`, so that page is the same list as the
 * feed, narrowed — infinite scroll, the in-flight rows and the row rendering all come with it.
 */
export function activityGroupMatcher(
  kind: ActivityGroupKind,
  id?: string,
  activityKeys?: ActivityKeyMemory
): (entry: IHistoryEntry) => boolean {
  const matches = groupKeyMatcher(kind, id, activityKeys);
  return entry => matches(activityGroupKeyOf(entry));
}

/** The group a claim card belongs to: the one its consume row joins (see `isFaucetClaimNote`). */
export function activityClaimGroupKeyOf(note: { faucetId: string; senderAddress: string }): ActivityGroupKey {
  return isFaucetClaimNote(note) ? { kind: 'faucet', id: 'faucet' } : activityAddressGroupKey(note.senderAddress);
}

/** `activityGroupMatcher` for claim cards, which have no history entry yet. */
export function activityClaimMatcher(
  kind: ActivityGroupKind,
  id?: string,
  activityKeys?: ActivityKeyMemory
): (note: { faucetId: string; senderAddress: string }) => boolean {
  const matches = groupKeyMatcher(kind, id, activityKeys);
  return note => matches(activityClaimGroupKeyOf(note));
}

function groupKeyMatcher(
  kind: ActivityGroupKind,
  id: string | undefined,
  activityKeys?: ActivityKeyMemory
): (key: ActivityGroupKey) => boolean {
  const wanted = kind === 'address' && id !== undefined ? activityCounterpartyKey(id, activityKeys) : undefined;
  return key => key.kind === kind && (kind !== 'address' || activityCounterpartyKey(key.id, activityKeys) === wanted);
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
