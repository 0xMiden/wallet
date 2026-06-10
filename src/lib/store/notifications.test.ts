import {
  AgglayerBridgeInPayload,
  EVENT_NOTIFICATION_MAX_AGE_MS,
  PendingNoteNotification,
  PendingNotePayload,
  pruneStaleEventNotifications,
  reconcilePendingNotes,
  reconcileTransactionNotifications,
  TransactionNotification,
  TransactionNotificationCandidate,
  upsertAgglayerBridgeInNotifications
} from './notifications';

// In-memory stand-in for the platform storage adapter (extension
// browser.storage.local / Capacitor Preferences / desktop localStorage).
const memoryStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) =>
      Object.fromEntries(keys.filter(key => key in memoryStore).map(key => [key, memoryStore[key]])),
    set: async (items: Record<string, unknown>) => {
      Object.assign(memoryStore, items);
    },
    remove: async (keys: string[]) => {
      for (const key of keys) delete memoryStore[key];
    }
  })
}));

const NOW = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);

const payload = (noteId: string): PendingNotePayload => ({
  noteId,
  faucetId: 'faucet-1',
  amount: '1000000',
  senderAddress: 'mtst1sender',
  symbol: 'MDN',
  decimals: 6
});

const notification = (noteId: string, overrides?: Partial<PendingNoteNotification>): PendingNoteNotification => ({
  id: `pending-note:${noteId}`,
  kind: 'pending-note',
  accountPublicKey: 'account-1',
  createdAt: NOW - 10_000,
  readAt: null,
  payload: payload(noteId),
  ...overrides
});

const txCandidate = (txId: string, completedAtSec: number): TransactionNotificationCandidate => ({
  completedAtSec,
  payload: {
    txId,
    txType: 'send',
    status: 'completed',
    amount: '500000',
    faucetId: 'faucet-1',
    symbol: 'MDN',
    decimals: 6
  }
});

const txNotification = (txId: string, overrides?: Partial<TransactionNotification>): TransactionNotification => ({
  id: `tx:${txId}`,
  kind: 'transaction',
  accountPublicKey: 'account-1',
  createdAt: NOW - 10_000,
  readAt: null,
  payload: {
    txId,
    txType: 'send',
    status: 'completed'
  },
  ...overrides
});

const agglayerDeposit = (txHash: string, readyForClaim: boolean): AgglayerBridgeInPayload => ({
  txHash,
  depositCnt: 1,
  amount: '1000000000000000000',
  symbol: 'ETH',
  decimals: 18,
  readyForClaim
});

describe('reconcilePendingNotes', () => {
  it('adds unread notifications for unseen notes', () => {
    const { next, changed } = reconcilePendingNotes([], 'account-1', [payload('note-a')], NOW);

    expect(changed).toBe(true);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: 'pending-note:note-a',
      kind: 'pending-note',
      accountPublicKey: 'account-1',
      createdAt: NOW,
      readAt: null
    });
  });

  it('prunes notifications whose note left the claimable set', () => {
    const existing = [notification('note-a'), notification('note-b')];

    const { next, changed } = reconcilePendingNotes(existing, 'account-1', [payload('note-b')], NOW);

    expect(changed).toBe(true);
    expect(next).toHaveLength(1);
    expect(next[0]?.kind === 'pending-note' && next[0].payload.noteId).toBe('note-b');
  });

  it('preserves readAt on notifications that are still current', () => {
    const readAt = NOW - 5_000;
    const existing = [notification('note-a', { readAt })];

    const { next } = reconcilePendingNotes(existing, 'account-1', [payload('note-a'), payload('note-b')], NOW);

    const kept = next.find(n => n.kind === 'pending-note' && n.payload.noteId === 'note-a');
    const added = next.find(n => n.kind === 'pending-note' && n.payload.noteId === 'note-b');
    expect(kept?.readAt).toBe(readAt);
    expect(added?.readAt).toBeNull();
  });

  it('returns changed=false on identical input', () => {
    const existing = [notification('note-a')];

    const { next, changed } = reconcilePendingNotes(existing, 'account-1', [payload('note-a')], NOW);

    expect(changed).toBe(false);
    expect(next).toBe(existing);
  });

  it('handles an empty claimable set by pruning everything', () => {
    const existing = [notification('note-a'), notification('note-b')];

    const { next, changed } = reconcilePendingNotes(existing, 'account-1', [], NOW);

    expect(changed).toBe(true);
    expect(next).toHaveLength(0);
  });

  it('leaves other notification kinds untouched', () => {
    const existing = [txNotification('tx-1', { createdAt: NOW - 1_000 })];

    const { next } = reconcilePendingNotes(existing, 'account-1', [], NOW);

    expect(next).toEqual(existing);
  });
});

describe('pruneStaleEventNotifications', () => {
  it('drops event notifications older than 7 days but keeps fresh ones', () => {
    const stale = txNotification('tx-old', { createdAt: NOW - EVENT_NOTIFICATION_MAX_AGE_MS - 1 });
    const fresh = txNotification('tx-new', { createdAt: NOW - 1_000 });

    const { next, changed } = pruneStaleEventNotifications([stale, fresh], NOW);

    expect(changed).toBe(true);
    expect(next).toEqual([fresh]);
  });

  it('never prunes pending-note notifications by age', () => {
    const old = notification('note-a', { createdAt: NOW - EVENT_NOTIFICATION_MAX_AGE_MS * 2 });

    const { next, changed } = pruneStaleEventNotifications([old], NOW);

    expect(changed).toBe(false);
    expect(next).toEqual([old]);
  });
});

describe('reconcileTransactionNotifications', () => {
  it('initializes the watermark with zero notifications on first run', () => {
    const candidates = [txCandidate('tx-1', NOW_SEC - 100)];

    const { next, watermarkSec, changed } = reconcileTransactionNotifications(
      [],
      'account-1',
      candidates,
      undefined,
      NOW
    );

    expect(changed).toBe(true);
    expect(next).toHaveLength(0);
    expect(watermarkSec).toBe(NOW_SEC);
  });

  it('notifies only transactions newer than the watermark and advances it', () => {
    const watermark = NOW_SEC - 60;
    const older = txCandidate('tx-old', NOW_SEC - 120);
    const newer = txCandidate('tx-new', NOW_SEC - 30);

    const { next, watermarkSec, changed } = reconcileTransactionNotifications(
      [],
      'account-1',
      [older, newer],
      watermark,
      NOW
    );

    expect(changed).toBe(true);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: 'tx:tx-new',
      kind: 'transaction',
      createdAt: (NOW_SEC - 30) * 1000,
      readAt: null
    });
    expect(watermarkSec).toBe(NOW_SEC - 30);
  });

  it('dedupes against already-present notification ids', () => {
    const existing = [txNotification('tx-1', { createdAt: NOW - 1_000 })];

    const { next } = reconcileTransactionNotifications(
      existing,
      'account-1',
      [txCandidate('tx-1', NOW_SEC - 10)],
      NOW_SEC - 60,
      NOW
    );

    expect(next.filter(n => n.id === 'tx:tx-1')).toHaveLength(1);
  });

  it('notifies failed transactions', () => {
    const failed: TransactionNotificationCandidate = {
      completedAtSec: NOW_SEC - 10,
      payload: { txId: 'tx-fail', txType: 'send', status: 'failed', error: 'boom' }
    };

    const { next } = reconcileTransactionNotifications([], 'account-1', [failed], NOW_SEC - 60, NOW);

    expect(next[0]).toMatchObject({ id: 'tx:tx-fail', kind: 'transaction' });
    expect(next[0]?.kind === 'transaction' && next[0].payload.status).toBe('failed');
  });

  it('returns changed=false when nothing is new', () => {
    const existing = [notification('note-a')];

    const { next, changed } = reconcileTransactionNotifications(existing, 'account-1', [], NOW_SEC, NOW);

    expect(changed).toBe(false);
    expect(next).toBe(existing);
  });
});

describe('upsertAgglayerBridgeInNotifications', () => {
  it('skips unseen deposits that are already claimable', () => {
    const { next, changed } = upsertAgglayerBridgeInNotifications(
      [],
      'account-1',
      [agglayerDeposit('0xready', true)],
      NOW
    );

    expect(changed).toBe(false);
    expect(next).toHaveLength(0);
  });

  it('creates an unread notification for an in-flight deposit', () => {
    const { next, changed } = upsertAgglayerBridgeInNotifications(
      [],
      'account-1',
      [agglayerDeposit('0xabc', false)],
      NOW
    );

    expect(changed).toBe(true);
    expect(next[0]).toMatchObject({
      id: 'bridge-in-agglayer:0xabc',
      kind: 'bridge-in-agglayer',
      readAt: null,
      createdAt: NOW
    });
  });

  it('updates the payload and resets readAt when a deposit becomes claimable', () => {
    const seeded = upsertAgglayerBridgeInNotifications([], 'account-1', [agglayerDeposit('0xabc', false)], NOW - 5_000);
    const read = seeded.next.map(n => ({ ...n, readAt: NOW - 4_000 }));

    const { next, changed } = upsertAgglayerBridgeInNotifications(
      read,
      'account-1',
      [agglayerDeposit('0xabc', true)],
      NOW
    );

    expect(changed).toBe(true);
    expect(next[0]).toMatchObject({
      id: 'bridge-in-agglayer:0xabc',
      readAt: null,
      createdAt: NOW - 5_000
    });
    expect(next[0]?.kind === 'bridge-in-agglayer' && next[0].payload.readyForClaim).toBe(true);
  });

  it('returns changed=false on identical input', () => {
    const seeded = upsertAgglayerBridgeInNotifications([], 'account-1', [agglayerDeposit('0xabc', false)], NOW);

    const { next, changed } = upsertAgglayerBridgeInNotifications(
      seeded.next,
      'account-1',
      [agglayerDeposit('0xabc', false)],
      NOW + 8_000
    );

    expect(changed).toBe(false);
    expect(next).toBe(seeded.next);
  });
});

// Persistence goes through the shared storage adapter (getStorageProvider) —
// mocked here with an in-memory provider, the same pattern the vault/dapp
// tests use.
describe('notifications-storage (storage-adapter)', () => {
  afterEach(() => {
    for (const key of Object.keys(memoryStore)) delete memoryStore[key];
  });

  it('round-trips the new {byAccount, txWatermarks} shape', async () => {
    const { loadPersistedNotifications, persistNotifications } = await import('./notifications-storage');

    const state = {
      byAccount: { 'account-1': [notification('note-a'), txNotification('tx-1')] },
      txWatermarks: { 'account-1': NOW_SEC }
    };
    await persistNotifications(state);

    const loaded = await loadPersistedNotifications();
    expect(loaded).toEqual(state);
  });

  it('migrates the legacy Record<account, list> shape with empty watermarks', async () => {
    const { loadPersistedNotifications } = await import('./notifications-storage');

    memoryStore['notifications'] = { 'account-1': [notification('note-a')] };

    const loaded = await loadPersistedNotifications();
    expect(loaded).toEqual({
      byAccount: { 'account-1': [notification('note-a')] },
      txWatermarks: {}
    });
  });

  it('returns an empty state for corrupt stored data', async () => {
    const { loadPersistedNotifications } = await import('./notifications-storage');

    memoryStore['notifications'] = 'not-json';
    expect(await loadPersistedNotifications()).toEqual({ byAccount: {}, txWatermarks: {} });

    memoryStore['notifications'] = { 'account-1': [{ bogus: true }] };
    expect(await loadPersistedNotifications()).toEqual({ byAccount: { 'account-1': [] }, txWatermarks: {} });
  });
});
