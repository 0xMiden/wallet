import { ITransactionStatus, ITransactionType } from 'lib/miden/db/types';
import { truncateAddress } from 'utils/string';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { isFaucetRequest } from './transactionUtils';

/**
 * What a group represents.
 *
 * `unknown` is a first-class kind rather than a bucket we hide — an entry the
 * wallet cannot attribute still has to be reachable. But it must stay *small*:
 * everything the wallet can name (a protocol, a self-maintenance operation)
 * gets named, so `unknown` means "we couldn't tell" and never "we never asked".
 */
export type ActivityGroupKind = 'contact' | 'app' | 'wallet' | 'unknown';

/**
 * A first-party flow, identified from the transaction's own `txType` rather
 * than from any recorded app identity.
 *
 * This is the only app attribution available today that needs no new persisted
 * metadata and cannot be spoofed by a restored backup: a swap is a swap because
 * the wallet built it as one.
 */
export type ActivityProtocol = 'swap' | 'earn' | 'bridge' | 'faucet';

const PROTOCOL_BY_TX_TYPE: Partial<Record<ITransactionType, ActivityProtocol>> = {
  swap: 'swap',
  // Earn's counterparty is the Epoch *allocator* account, and `earn-withdraw`
  // has no counterparty at all — so without this, deposits file under an opaque
  // address and withdrawals fall into `unknown`.
  'earn-deposit': 'earn',
  'earn-withdraw': 'earn',
  // A bridge send's `secondaryAddress` is an EVM `0x` address that can never
  // match the address book; a bridge receive has none.
  'bridged-send': 'bridge',
  'bridged-receive': 'bridge'
};

/**
 * Wallet self-maintenance: securing the account, rotating a key, changing
 * guardian. These carry no counterparty by construction and are not a
 * relationship, so they get their own de-emphasised group instead of diluting
 * `unknown`.
 */
const WALLET_TX_TYPES: ReadonlySet<ITransactionType> = new Set<ITransactionType>([
  'switch-guardian',
  'replace-hot-key',
  'update-procedure-threshold'
]);

export const UNKNOWN_GROUP_ID = 'unknown';
export const WALLET_GROUP_ID = 'wallet';

/** Something the user has to do, and when it stops being possible. */
export interface ActivityAction {
  /** Groups by the same key the entries use. */
  groupId: string;
  /**
   * Epoch ms after which the action lapses — a note returning to its sender,
   * for instance. Absent for open-ended actions.
   */
  deadlineAt?: number;
}

export interface ActivityGroup {
  /**
   * Canonical grouping key — `contact:<address>`, `protocol:<name>`,
   * `dapp:<origin>`, or the `wallet` / `unknown` literals. Stable across
   * renders so the row can be keyed and routed by it.
   */
  id: string;
  kind: ActivityGroupKind;
  /** Address-book name, protocol name, or a shortened address. Never a guess. */
  name: string;
  /** Present only for `contact`; the full address behind `name`. */
  address?: string;
  /** Set when the group is a first-party protocol flow. */
  protocol?: ActivityProtocol;
  entries: IHistoryEntry[];
  /** Timestamp of the newest entry — the row's relative time. */
  latestAt: number;
  /** How many things in this group the user must act on. */
  pendingCount: number;
  /** Soonest deadline among those actions, if any. Drives urgency ranking. */
  nextDeadlineAt?: number;
}

export interface ActivityGroupingSources {
  /** Address book. Only an exact address match names a group. */
  contacts?: Array<{ address: string; name: string }>;
  /**
   * Durable dApp attribution, keyed by the transaction key. Empty today — no
   * transaction persists an originating dApp — and supplied explicitly rather
   * than inferred, so a name can never come from an untrusted transaction field.
   */
  dappByEntryKey?: Record<string, { origin: string; name: string }>;
  /**
   * Everything the user must act on, already filtered for auto-consume and
   * in-flight claims by `useActionableActivity`. Not history entries: an
   * unclaimed note has no transaction, so an action can bring a group into
   * existence on its own.
   */
  actions?: readonly ActivityAction[];
  /** Display names for protocol groups — passed in to keep this module i18n-free. */
  protocolNames?: Partial<Record<ActivityProtocol, string>>;
}

/** Stable key for the group an entry belongs to. Chosen once, so no entry is double-counted. */
export function groupIdForEntry(entry: IHistoryEntry, dapp?: { origin: string }, protocol?: ActivityProtocol): string {
  if (dapp) return `dapp:${dapp.origin}`;
  if (protocol) return `protocol:${protocol}`;
  if (WALLET_TX_TYPES.has(entry.txType)) return WALLET_GROUP_ID;
  if (entry.secondaryAddress) return `contact:${entry.secondaryAddress}`;
  return UNKNOWN_GROUP_ID;
}

/** The group key a counterparty address belongs to. Used to attach actions. */
export function groupIdForAddress(address?: string): string {
  return address ? `contact:${address}` : UNKNOWN_GROUP_ID;
}

function protocolOf(entry: IHistoryEntry): ActivityProtocol | undefined {
  // A faucet request is an ordinary `consume` whose sender happens to be the
  // faucet, so it is detected rather than typed.
  if (isFaucetRequest(entry)) return 'faucet';
  return PROTOCOL_BY_TX_TYPE[entry.txType];
}

function isInFlight(entry: IHistoryEntry): boolean {
  return (
    entry.type === HistoryEntryType.PendingTransaction ||
    entry.type === HistoryEntryType.ProcessingTransaction ||
    entry.status === ITransactionStatus.Queued ||
    entry.status === ITransactionStatus.GeneratingTransaction
  );
}

/**
 * Rank tier — lower sorts first. A chat list orders purely by recency because
 * every message is equal; here they are not, so what needs doing outranks what
 * happened last.
 */
function tierOf(group: ActivityGroup): number {
  if (group.pendingCount > 0) return group.nextDeadlineAt !== undefined ? 0 : 1;
  if (group.entries.some(isInFlight)) return 2;
  return group.kind === 'wallet' ? 4 : 3;
}

/**
 * Fold a flat, already-ordered history into one row per counterparty.
 *
 * Precedence is dApp → protocol → wallet → contact. An entry attributed to an
 * app is *about* that app, and its counterparty address is an implementation
 * detail: a swap's counterparty is the matching order and an earn deposit's is
 * the Epoch allocator, so filing either under an address would invent a
 * relationship the user never had.
 */
export function groupActivity(
  entries: readonly IHistoryEntry[],
  sources: ActivityGroupingSources = {}
): ActivityGroup[] {
  const contactByAddress = new Map((sources.contacts ?? []).map(c => [c.address, c.name]));
  const dappByEntryKey = sources.dappByEntryKey ?? {};

  const groups = new Map<string, ActivityGroup>();

  const nameForContact = (address: string) =>
    // A saved name, or the address itself shortened. Never a name carried on the
    // transaction — those are attacker-authorable on a restored row.
    contactByAddress.get(address) ?? truncateAddress(address, true, 8);

  for (const entry of entries) {
    const dapp = dappByEntryKey[entry.key];
    const protocol = dapp ? undefined : protocolOf(entry);
    const id = groupIdForEntry(entry, dapp, protocol);

    const existing = groups.get(id);
    if (existing) {
      existing.entries.push(entry);
      existing.latestAt = Math.max(existing.latestAt, entry.timestamp);
      continue;
    }

    const kind: ActivityGroupKind =
      dapp || protocol ? 'app' : id === WALLET_GROUP_ID ? 'wallet' : id === UNKNOWN_GROUP_ID ? 'unknown' : 'contact';

    groups.set(id, {
      id,
      kind,
      name: dapp
        ? dapp.name
        : protocol
          ? (sources.protocolNames?.[protocol] ?? protocol)
          : kind === 'contact' && entry.secondaryAddress
            ? nameForContact(entry.secondaryAddress)
            : '',
      address: kind === 'contact' ? entry.secondaryAddress : undefined,
      protocol,
      entries: [entry],
      latestAt: entry.timestamp,
      pendingCount: 0
    });
  }

  // Actions second, so something you must do surfaces even with no transaction
  // behind it yet — a first-time sender's transfer has to be actionable before
  // any row for it exists.
  for (const action of sources.actions ?? []) {
    const existing = groups.get(action.groupId);
    const target =
      existing ??
      (() => {
        const address = action.groupId.startsWith('contact:') ? action.groupId.slice('contact:'.length) : undefined;
        const created: ActivityGroup = {
          id: action.groupId,
          kind: address ? 'contact' : action.groupId === UNKNOWN_GROUP_ID ? 'unknown' : 'app',
          name: address ? nameForContact(address) : '',
          address,
          entries: [],
          // Nothing to date it by; ranking puts it up top on the action instead.
          latestAt: 0,
          pendingCount: 0
        };
        groups.set(action.groupId, created);
        return created;
      })();

    target.pendingCount += 1;
    if (action.deadlineAt !== undefined) {
      target.nextDeadlineAt =
        target.nextDeadlineAt === undefined ? action.deadlineAt : Math.min(target.nextDeadlineAt, action.deadlineAt);
    }
  }

  return Array.from(groups.values())
    .map(group => ({ ...group, entries: [...group.entries].sort((a, b) => b.timestamp - a.timestamp) }))
    .sort((a, b) => {
      const tier = tierOf(a) - tierOf(b);
      if (tier !== 0) return tier;
      // Soonest deadline first inside the urgent tier.
      if (a.nextDeadlineAt !== undefined && b.nextDeadlineAt !== undefined && a.nextDeadlineAt !== b.nextDeadlineAt) {
        return a.nextDeadlineAt - b.nextDeadlineAt;
      }
      return b.latestAt - a.latestAt;
    });
}
