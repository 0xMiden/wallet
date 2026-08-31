import { ITransactionType } from 'lib/miden/db/types';
import { truncateAddress } from 'utils/string';

import { IHistoryEntry } from './IHistoryEntry';

/**
 * What a group represents. `unknown` is deliberately a first-class kind rather
 * than a dumping ground we hide: an entry the wallet cannot attribute still has
 * to be reachable, so it gets a real row instead of being filtered out.
 */
export type ActivityGroupKind = 'contact' | 'dapp' | 'unknown';

/**
 * A first-party flow the wallet itself runs, identified from the transaction's
 * own `txType` rather than from any recorded dApp identity.
 *
 * This is the one kind of app attribution available today that needs no new
 * persisted metadata and cannot be spoofed by a restored backup: an
 * in-protocol swap is a swap because the wallet built it as one. Extend the
 * map below to give Earn or the bridges their own group.
 */
export type ActivityProtocol = 'swap';

const PROTOCOL_BY_TX_TYPE: Partial<Record<ITransactionType, ActivityProtocol>> = {
  swap: 'swap'
};

export interface ActivityGroup {
  /**
   * Canonical grouping key — a Miden address for `contact`, an origin for
   * `dapp`, the literal `'unknown'` otherwise. Stable across renders so the
   * row can be keyed and routed by it.
   */
  id: string;
  kind: ActivityGroupKind;
  /** Address-book name, dApp name, or a shortened address. Never a raw guess. */
  name: string;
  /** Present only for `contact`; the full address behind `name`. */
  address?: string;
  /** Set when the group is a first-party protocol flow, e.g. the in-protocol DEX. */
  protocol?: ActivityProtocol;
  entries: IHistoryEntry[];
  /** Timestamp of the newest entry, i.e. what the list sorts on. */
  latestAt: number;
  /** Entries in this group that still need the user to claim something. */
  pendingCount: number;
}

export interface ActivityGroupingSources {
  /** Address book. Only an exact address match names a group. */
  contacts?: Array<{ address: string; name: string }>;
  /**
   * Durable dApp attribution, keyed by the transaction key. Empty today — no
   * transaction persists an originating dApp (see `ITransaction`), so nothing
   * produces `dapp` groups from real history yet. Supplied explicitly rather
   * than inferred, so a name can never come from an untrusted transaction field.
   */
  dappByEntryKey?: Record<string, { origin: string; name: string }>;
  /**
   * Notes the user still has to claim, from `useClaimableNotes`. These are NOT
   * history entries — a note nobody has claimed yet has no transaction — so
   * they are folded in separately and can bring a group into existence on
   * their own. That is the point: a first-time sender's claim has to be
   * actionable before any transaction for it exists.
   */
  pendingClaims?: Array<{ id: string; senderAddress?: string }>;
  /**
   * Display names for the first-party protocol groups. Passed in rather than
   * looked up here so this module stays free of i18n and of React.
   */
  protocolNames?: Partial<Record<ActivityProtocol, string>>;
}

export const UNKNOWN_GROUP_ID = 'unknown';

/**
 * Fold a flat, already-ordered history into one row per counterparty.
 *
 * Precedence is dApp, then protocol, then contact. An entry attributed to an
 * app is *about* that app, and its counterparty address is an implementation
 * detail — a swap's counterparty is the matching order, not a person, so
 * filing it under an address would invent a relationship that does not exist.
 * Every entry lands in exactly one group: the key is chosen once, here, so no
 * entry can be double-counted.
 */
export function groupActivity(
  entries: readonly IHistoryEntry[],
  sources: ActivityGroupingSources = {}
): ActivityGroup[] {
  const contactByAddress = new Map((sources.contacts ?? []).map(c => [c.address, c.name]));
  const dappByEntryKey = sources.dappByEntryKey ?? {};

  const groups = new Map<string, ActivityGroup>();

  for (const entry of entries) {
    const dapp = dappByEntryKey[entry.key];
    const counterparty = entry.secondaryAddress;

    let id: string;
    let kind: ActivityGroupKind;
    let name: string;
    let address: string | undefined;
    // Describes the GROUP, not the entry: a swap that a real dApp claimed is
    // that dApp's, so this stays unset and the row shows the dApp instead.
    let protocol: ActivityProtocol | undefined;

    const entryProtocol = PROTOCOL_BY_TX_TYPE[entry.txType];

    if (dapp) {
      id = `dapp:${dapp.origin}`;
      kind = 'dapp';
      name = dapp.name;
    } else if (entryProtocol) {
      id = `protocol:${entryProtocol}`;
      kind = 'dapp';
      name = sources.protocolNames?.[entryProtocol] ?? entryProtocol;
      protocol = entryProtocol;
    } else if (counterparty) {
      id = `contact:${counterparty}`;
      kind = 'contact';
      address = counterparty;
      // A saved name, or the address itself shortened. Never a name carried on
      // the transaction — those are attacker-authorable on a restored row.
      name = contactByAddress.get(counterparty) ?? truncateAddress(counterparty, true, 8);
    } else {
      id = UNKNOWN_GROUP_ID;
      kind = 'unknown';
      name = '';
    }

    const existing = groups.get(id);
    if (existing) {
      existing.entries.push(entry);
      existing.latestAt = Math.max(existing.latestAt, entry.timestamp);
    } else {
      groups.set(id, {
        id,
        kind,
        name,
        address,
        protocol,
        entries: [entry],
        latestAt: entry.timestamp,
        pendingCount: 0
      });
    }
  }

  // Pending claims second, so a claim from someone with no transaction history
  // still surfaces as its own actionable row rather than vanishing.
  for (const claim of sources.pendingClaims ?? []) {
    const sender = claim.senderAddress;
    const id = sender ? `contact:${sender}` : UNKNOWN_GROUP_ID;
    const existing = groups.get(id);
    if (existing) {
      existing.pendingCount += 1;
    } else {
      groups.set(id, {
        id,
        kind: sender ? 'contact' : 'unknown',
        name: sender ? (contactByAddress.get(sender) ?? truncateAddress(sender, true, 8)) : '',
        address: sender,
        entries: [],
        // No transaction to date it by; sorts last among groups until one lands.
        latestAt: 0,
        pendingCount: 1
      });
    }
  }

  // Newest group first; entries inside a group stay newest-first too, which is
  // the order the flat feed already hands us.
  return Array.from(groups.values())
    .map(group => ({ ...group, entries: [...group.entries].sort((a, b) => b.timestamp - a.timestamp) }))
    .sort((a, b) => b.latestAt - a.latestAt);
}
