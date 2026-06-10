import { IBridgeProvider, ITransactionType } from 'lib/miden/db/types';

export type NotificationKind = 'pending-note' | 'transaction' | 'bridge-in-agglayer' | 'bridge-in-epoch';

/** Event notifications (everything except pending-note) prune after this age. */
export const EVENT_NOTIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingNotePayload {
  noteId: string;
  faucetId: string;
  /** Base units — render via formatBigInt(BigInt(amount), decimals) */
  amount: string;
  senderAddress: string;
  symbol: string;
  decimals: number;
}

export interface TransactionNotificationPayload {
  /** Db row uuid — navigates to /history-details/:txId */
  txId: string;
  txType: ITransactionType;
  status: 'completed' | 'failed';
  /** Base units */
  amount?: string;
  faucetId?: string;
  symbol?: string;
  decimals?: number;
  /** Raw backend copy (non-i18n) — title fallback only */
  displayMessage?: string;
  error?: string;
  /** consume transactions */
  noteId?: string;
  /** bridged-send transactions */
  provider?: IBridgeProvider;
  destinationAddress?: string;
}

export interface AgglayerBridgeInPayload {
  /** EVM origin tx hash — stable id source */
  txHash: string;
  depositCnt: number;
  /** Wei string */
  amount: string;
  symbol: string;
  decimals: number;
  readyForClaim: boolean;
  claimTxHash?: string;
}

export interface EpochBridgeInPayload {
  intentNonce?: string;
  /** Human-entered EVM-side input amount */
  amount: string;
  symbol: string;
  /** Formatted destination-side output amount */
  receivedAmount?: string;
  receivedSymbol?: string;
  status: 'confirmed' | 'failed';
  fillTxHash?: string;
  error?: string;
}

interface NotificationBase {
  id: string;
  accountPublicKey: string;
  createdAt: number;
  /** null = unread */
  readAt: number | null;
}

export interface PendingNoteNotification extends NotificationBase {
  kind: 'pending-note';
  payload: PendingNotePayload;
}

export interface TransactionNotification extends NotificationBase {
  kind: 'transaction';
  payload: TransactionNotificationPayload;
}

export interface AgglayerBridgeInNotification extends NotificationBase {
  kind: 'bridge-in-agglayer';
  payload: AgglayerBridgeInPayload;
}

export interface EpochBridgeInNotification extends NotificationBase {
  kind: 'bridge-in-epoch';
  payload: EpochBridgeInPayload;
}

// Named AppNotification to avoid colliding with the intercom broadcast
// union `WalletNotification` in lib/shared/types.ts.
export type AppNotification =
  | PendingNoteNotification
  | TransactionNotification
  | AgglayerBridgeInNotification
  | EpochBridgeInNotification;

export function pendingNoteNotificationId(noteId: string): string {
  return `pending-note:${noteId}`;
}

export function transactionNotificationId(txId: string): string {
  return `tx:${txId}`;
}

export function agglayerBridgeInNotificationId(txHash: string): string {
  return `bridge-in-agglayer:${txHash}`;
}

export function epochBridgeInNotificationId(key: string): string {
  return `bridge-in-epoch:${key}`;
}

/**
 * Drop event notifications (any kind except pending-note) older than
 * EVENT_NOTIFICATION_MAX_AGE_MS. Pending-note notifications are pruned by
 * the claimable-set reconcile instead, so they are immune here.
 */
export function pruneStaleEventNotifications(
  existing: AppNotification[],
  now: number
): { next: AppNotification[]; changed: boolean } {
  const cutoff = now - EVENT_NOTIFICATION_MAX_AGE_MS;
  const next = existing.filter(n => n.kind === 'pending-note' || n.createdAt >= cutoff);
  return next.length === existing.length ? { next: existing, changed: false } : { next, changed: true };
}

/**
 * Diff the current claimable notes against the stored notifications for an
 * account. Adds an unread notification for each unseen note and drops
 * pending-note notifications whose note left the claimable set
 * (claimed/consumed/recalled). Other notification kinds pass through
 * untouched. Returns `changed: false` when nothing differs so callers can
 * skip set()/persist.
 */
export function reconcilePendingNotes(
  existing: AppNotification[],
  accountPublicKey: string,
  currentNotes: PendingNotePayload[],
  now: number
): { next: AppNotification[]; changed: boolean } {
  const currentNoteIds = new Set(currentNotes.map(n => n.noteId));

  const kept = existing.filter(n => n.kind !== 'pending-note' || currentNoteIds.has(n.payload.noteId));

  const seenNoteIds = new Set(kept.filter(n => n.kind === 'pending-note').map(n => n.payload.noteId));

  const added: AppNotification[] = currentNotes
    .filter(note => !seenNoteIds.has(note.noteId))
    .map(note => ({
      id: pendingNoteNotificationId(note.noteId),
      kind: 'pending-note',
      accountPublicKey,
      createdAt: now,
      readAt: null,
      payload: note
    }));

  const changed = added.length > 0 || kept.length !== existing.length;
  return changed ? { next: [...kept, ...added], changed } : { next: existing, changed };
}

export interface TransactionNotificationCandidate {
  payload: TransactionNotificationPayload;
  /** Transaction completedAt — SECONDS (db convention) */
  completedAtSec: number;
}

/**
 * Diff terminal-status transactions against stored notifications using a
 * per-account watermark (seconds).
 *
 * First run (watermark undefined): initializes the watermark to `now` and
 * creates NO notifications — prevents backfilling history when the feature
 * first ships. Afterwards only transactions newer than the watermark
 * notify; the watermark advances to the newest candidate. Stale event
 * notifications are pruned in the same pass.
 */
export function reconcileTransactionNotifications(
  existing: AppNotification[],
  accountPublicKey: string,
  candidates: TransactionNotificationCandidate[],
  watermarkSec: number | undefined,
  now: number
): { next: AppNotification[]; watermarkSec: number; changed: boolean } {
  if (watermarkSec === undefined) {
    return { next: existing, watermarkSec: Math.floor(now / 1000), changed: true };
  }

  const { next: pruned, changed: prunedChanged } = pruneStaleEventNotifications(existing, now);

  const existingIds = new Set(pruned.map(n => n.id));
  let nextWatermark = watermarkSec;
  const added: AppNotification[] = [];

  for (const candidate of candidates) {
    if (candidate.completedAtSec <= watermarkSec) continue;
    nextWatermark = Math.max(nextWatermark, candidate.completedAtSec);

    const id = transactionNotificationId(candidate.payload.txId);
    if (existingIds.has(id)) continue;
    existingIds.add(id);

    added.push({
      id,
      kind: 'transaction',
      accountPublicKey,
      createdAt: candidate.completedAtSec * 1000,
      readAt: null,
      payload: candidate.payload
    });
  }

  const changed = prunedChanged || added.length > 0 || nextWatermark !== watermarkSec;
  return changed
    ? { next: [...pruned, ...added], watermarkSec: nextWatermark, changed }
    : { next: existing, watermarkSec, changed };
}

/**
 * Upsert incoming Agglayer bridge deposits as notifications.
 *
 * Unseen deposits that are already claimable are skipped — they are either
 * historical (the indexer has no timestamps to age them by) or were settled
 * while the wallet was closed; notifying would backfill noise and recreate
 * pruned rows forever. Unseen in-flight deposits create an unread
 * notification. When a seen deposit flips to ready_for_claim, the payload
 * updates and readAt resets to null so the badge re-fires at the actionable
 * moment.
 */
export function upsertAgglayerBridgeInNotifications(
  existing: AppNotification[],
  accountPublicKey: string,
  deposits: AgglayerBridgeInPayload[],
  now: number
): { next: AppNotification[]; changed: boolean } {
  const byId = new Map(existing.map(n => [n.id, n]));
  let changed = false;

  for (const deposit of deposits) {
    const id = agglayerBridgeInNotificationId(deposit.txHash);
    const current = byId.get(id);

    if (!current) {
      if (deposit.readyForClaim) continue;
      byId.set(id, {
        id,
        kind: 'bridge-in-agglayer',
        accountPublicKey,
        createdAt: now,
        readAt: null,
        payload: deposit
      });
      changed = true;
      continue;
    }

    if (current.kind !== 'bridge-in-agglayer') continue;

    const becameReady = !current.payload.readyForClaim && deposit.readyForClaim;
    const payloadChanged =
      current.payload.readyForClaim !== deposit.readyForClaim || current.payload.claimTxHash !== deposit.claimTxHash;

    if (payloadChanged) {
      byId.set(id, {
        ...current,
        readAt: becameReady ? null : current.readAt,
        payload: deposit
      });
      changed = true;
    }
  }

  return changed ? { next: Array.from(byId.values()), changed } : { next: existing, changed };
}
