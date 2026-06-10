import { getStorageProvider } from 'lib/platform/storage-adapter';

import { AppNotification, NotificationKind } from './notifications';

// Resolves per platform via the shared storage adapter: extension →
// browser.storage.local, mobile → Capacitor Preferences (more durable than
// WebView localStorage), desktop/web → localStorage (with the adapter's
// `miden_wallet_` prefix).
const STORAGE_KEY = 'notifications';
const MAX_NOTIFICATIONS_PER_ACCOUNT = 50;

const KNOWN_KINDS: NotificationKind[] = ['pending-note', 'transaction', 'bridge-in-agglayer', 'bridge-in-epoch'];

export type NotificationsByAccount = Record<string, AppNotification[]>;

export interface PersistedNotificationsState {
  byAccount: NotificationsByAccount;
  /** Per-account transaction-notification watermark — SECONDS */
  txWatermarks: Record<string, number>;
}

const EMPTY_STATE: PersistedNotificationsState = { byAccount: {}, txWatermarks: {} };

function isKnownKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && KNOWN_KINDS.some(kind => kind === value);
}

function isAppNotification(value: unknown): value is AppNotification {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    isKnownKind(value.kind) &&
    'id' in value &&
    typeof value.id === 'string' &&
    'accountPublicKey' in value &&
    typeof value.accountPublicKey === 'string' &&
    'createdAt' in value &&
    typeof value.createdAt === 'number' &&
    'payload' in value &&
    typeof value.payload === 'object' &&
    value.payload !== null
  );
}

function parseByAccount(raw: unknown): NotificationsByAccount {
  if (typeof raw !== 'object' || raw === null) return {};
  const result: NotificationsByAccount = {};
  for (const [account, list] of Object.entries(raw)) {
    if (Array.isArray(list)) {
      result[account] = list.filter(isAppNotification);
    }
  }
  return result;
}

function parseWatermarks(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return {};
  const result: Record<string, number> = {};
  for (const [account, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[account] = value;
    }
  }
  return result;
}

function parseState(raw: unknown): PersistedNotificationsState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_STATE;

  // New shape: { byAccount, txWatermarks }
  if ('byAccount' in raw) {
    const watermarks = 'txWatermarks' in raw ? raw.txWatermarks : undefined;
    return {
      byAccount: parseByAccount(raw.byAccount),
      txWatermarks: parseWatermarks(watermarks)
    };
  }

  // Legacy shape: Record<accountPublicKey, AppNotification[]>
  return { byAccount: parseByAccount(raw), txWatermarks: {} };
}

function capPerAccount(byAccount: NotificationsByAccount): NotificationsByAccount {
  const capped: NotificationsByAccount = {};
  for (const [account, list] of Object.entries(byAccount)) {
    capped[account] =
      list.length > MAX_NOTIFICATIONS_PER_ACCOUNT
        ? [...list].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_NOTIFICATIONS_PER_ACCOUNT)
        : list;
  }
  return capped;
}

export async function loadPersistedNotifications(): Promise<PersistedNotificationsState> {
  try {
    const result = await getStorageProvider().get([STORAGE_KEY]);
    return parseState(result[STORAGE_KEY]);
  } catch {
    return EMPTY_STATE;
  }
}

export async function persistNotifications(state: PersistedNotificationsState): Promise<void> {
  const capped: PersistedNotificationsState = {
    byAccount: capPerAccount(state.byAccount),
    txWatermarks: state.txWatermarks
  };

  try {
    await getStorageProvider().set({ [STORAGE_KEY]: capped });
  } catch {}
}
