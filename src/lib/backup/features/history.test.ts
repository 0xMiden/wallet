import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { b64ToU8 } from 'lib/shared/helpers';

import { HISTORY_BLOB_CAP, decryptEntry, encryptEntry } from '../crypto';
import { hashedKeyOf } from '../entries';
import { type BackupSession, clearBackupSession, getBackupSession } from '../session';
import { type HistoryState, getBackupDeviceId, onBackupStorageCleared } from '../state';
import {
  CHUNK_HEADROOM_BYTES,
  MAX_ROW_NOTE_IDS,
  applyHistoryRows,
  flushHistory,
  historyEntryKey,
  isAppendableRow,
  parseHistoryChunk,
  parseHistoryRow,
  peerHistoryChunkCount,
  projectTransaction,
  readHistory,
  restoreTransaction,
  spillOverfullChunks
} from './history';
import {
  FakeVault,
  FakeWalletApi,
  MemoryStorage,
  PHRASE_A,
  installCopyingImportKey,
  installFakeFetch,
  setActiveStorage,
  setActiveVault
} from '../testing/backup-harness';

jest.mock('lib/miden/back/store', () => {
  const harness = jest.requireActual<typeof import('../testing/backup-harness')>('../testing/backup-harness');
  return {
    store: { getState: () => harness.fakeStoreState() },
    isUnlocked: harness.isFakeUnlocked,
    accountsUpdated: jest.fn(),
    settingsUpdated: jest.fn()
  };
});
jest.mock('lib/platform/storage-adapter', () => {
  const harness = jest.requireActual<typeof import('../testing/backup-harness')>('../testing/backup-harness');
  return { getStorageProvider: () => harness.getActiveStorage() };
});
jest.mock('lib/remote-config/runtime', () => ({
  initBridgeConfig: jest.fn(async () => undefined),
  getBridgeConfigSnapshot: jest.fn()
}));
jest.mock('lib/remote-config/values', () => ({ getBackupBaseUrl: jest.fn(() => 'https://wallet-api.test') }));

function row(id: string, fields: Partial<ITransaction> = {}): ITransaction {
  return {
    id,
    type: 'send',
    accountId: 'acc-1',
    status: ITransactionStatus.Completed,
    initiatedAt: 1_700_000_000,
    completedAt: 1_700_000_010,
    displayIcon: 'SEND',
    transactionId: `tx-${id}`,
    secondaryAccountId: 'acc-2',
    faucetId: 'faucet-1',
    amount: 5n,
    ...fields
  };
}

describe('history projection', () => {
  it('preserves both Guardian endpoints without copying execution data', () => {
    const transaction = row('guardian-switch', {
      type: 'switch-guardian',
      extraInputs: {
        previousGuardianEndpoint: 'https://old.guardian.test',
        newGuardianEndpoint: 'https://new.guardian.test',
        switchProposalId: 'private-proposal',
        requestBytes: [1, 2]
      }
    });
    const projection = projectTransaction(transaction);
    expect(projection.x).toEqual({ pg: 'https://old.guardian.test', ng: 'https://new.guardian.test' });
    expect(restoreTransaction(projection).extraInputs).toEqual({
      previousGuardianEndpoint: 'https://old.guardian.test',
      newGuardianEndpoint: 'https://new.guardian.test'
    });
  });

  it('does not invent endpoints for a legacy Guardian switch receipt', () => {
    const restored = restoreTransaction(projectTransaction(row('legacy-switch', { type: 'switch-guardian' })));
    expect(restored.extraInputs).toBeUndefined();
  });

  it('preserves the revoked commitment and transaction hash across devices', () => {
    const target = `0x${'3'.repeat(64)}`;
    const restored = restoreTransaction(
      projectTransaction(
        row('revocation', {
          type: 'replace-hot-key',
          extraInputs: { revokedSignerCommitment: target, secret: 'discard' }
        })
      )
    );
    expect(restored.transactionId).toBe('tx-revocation');
    expect(restored.extraInputs).toEqual({ revokedSignerCommitment: target, mode: undefined });
    expect(restored.restoredFromBackup).toBe(true);
  });

  it('names a chunk history:<deviceId>:<n>', () => {
    expect(historyEntryKey('dev', 3)).toBe('history:dev:3');
  });

  it('appends only Completed rows of this device', () => {
    expect(isAppendableRow(row('a'))).toBe(true);
    expect(isAppendableRow(row('a', { status: ITransactionStatus.Failed }))).toBe(false);
    expect(isAppendableRow(row('a', { status: ITransactionStatus.Unconfirmed }))).toBe(false);
    expect(isAppendableRow(row('a', { restoredFromBackup: true }))).toBe(false);
    expect(isAppendableRow(row('a', { recovered: true }))).toBe(false);
  });

  it('projects a row with unix ms, decimal amounts and at most 16 note ids', () => {
    const notes = Array.from({ length: 20 }, (_value, index) => `note-${index}`);
    const projected = projectTransaction(
      row('a', { feeAmount: 2n, noteId: 'note-0', outputNoteIds: notes, displayMessage: 'Sent' })
    );
    expect(projected).toMatchObject({
      v: 1,
      id: 'a',
      t: 'send',
      s: ITransactionStatus.Completed,
      a: 'acc-1',
      am: '5',
      fa: '2',
      tx: 'tx-a',
      ia: 1_700_000_000_000,
      ca: 1_700_000_010_000,
      m: 'Sent'
    });
    expect(projected.n).toHaveLength(MAX_ROW_NOTE_IDS);
    expect(projected.x).toBeUndefined();
  });

  it('keeps only the receipt fields of a swap', () => {
    const swap = row('s', {
      type: 'swap',
      outputNoteIds: ['order-note'],
      extraInputs: { requestedFaucetId: 'f2', requestedAmount: 9n, settledAt: 5, requestBytes: [1, 2] }
    });
    expect(projectTransaction(swap).x).toEqual({ rf: 'f2', ra: '9', on: 'order-note', sk: 'settle' });
  });

  it('round-trips a row into a read-only restored row', () => {
    const bridged = row('b', {
      type: 'bridged-send',
      extraInputs: { provider: 'agglayer', destinationNetwork: 7, claimTxHash: '0xabc', secret: 'dropped' }
    });
    const restored = restoreTransaction(projectTransaction(bridged));
    expect(restored).toMatchObject({
      id: 'b',
      type: 'bridged-send',
      status: ITransactionStatus.Completed,
      initiatedAt: 1_700_000_000,
      completedAt: 1_700_000_010,
      amount: 5n,
      transactionId: 'tx-b',
      restoredFromBackup: true
    });
    expect(restored.extraInputs).toMatchObject({ provider: 'agglayer', destinationNetwork: 7, claimTxHash: '0xabc' });
    expect(restored.extraInputs).not.toHaveProperty('secret', 'dropped');
  });

  it('puts the note ids of a consume in noteIds and of any other row in outputNoteIds', () => {
    const consume = restoreTransaction(projectTransaction(row('c', { type: 'consume', noteIds: ['n1', 'n2'] })));
    expect(consume.noteIds).toEqual(['n1', 'n2']);
    expect(consume.outputNoteIds).toBeUndefined();
    const send = restoreTransaction(projectTransaction(row('d', { outputNoteIds: ['n3'] })));
    expect(send.outputNoteIds).toEqual(['n3']);
    expect(send.noteId).toBe('n3');
  });

  it('restores a swap request as a bigint and its settlement time', () => {
    const swap = row('s', {
      type: 'swap',
      extraInputs: { requestedFaucetId: 'f2', requestedAmount: 9n, reclaimedAt: 1 }
    });
    expect(restoreTransaction(projectTransaction(swap)).extraInputs).toMatchObject({
      requestedAmount: 9n,
      reclaimedAt: 1_700_000_010_000
    });
  });

  it.each([
    ['a Queued row', { s: ITransactionStatus.Queued }],
    ['a generating row', { s: ITransactionStatus.GeneratingTransaction }],
    ['an Unconfirmed row', { s: ITransactionStatus.Unconfirmed }],
    ['an unknown type', { t: 'mint' }],
    ['an unknown icon', { ic: 'STAR' }],
    ['an empty id', { id: '' }],
    ['a negative time', { ia: -1 }],
    ['an amount that is not decimal', { am: '1.5' }],
    ['note ids that are not a list', { n: 'note' }]
  ])('refuses %s', (_name, change) => {
    expect(parseHistoryRow({ ...projectTransaction(row('a')), ...change })).toBeNull();
  });

  it('keeps the plain fields of x and drops the others', () => {
    const parsed = parseHistoryRow({ ...projectTransaction(row('a')), x: { a: 'b', c: 1, d: { e: 1 }, f: Infinity } });
    expect(parsed?.x).toEqual({ a: 'b', c: 1 });
  });

  it('parses a chunk and drops rows of another shape', () => {
    const good = projectTransaction(row('a'));
    expect(parseHistoryChunk(JSON.stringify([good, { v: 2 }, 'x']))).toEqual([parseHistoryRow(good)]);
    expect(parseHistoryChunk('{')).toEqual([]);
    expect(parseHistoryChunk('{}')).toEqual([]);
  });
});

describe('applyHistoryRows', () => {
  it('adds new rows flagged restoredFromBackup', async () => {
    await expect(applyHistoryRows([projectTransaction(row('a'))])).resolves.toBe(1);
    const stored = await Repo.transactions.get('a');
    expect(stored?.restoredFromBackup).toBe(true);
    expect(stored?.amount).toBe(5n);
  });

  it('replaces a row restored before with the newer projection', async () => {
    await applyHistoryRows([projectTransaction(row('a'))]);
    await expect(applyHistoryRows([projectTransaction(row('a', { displayMessage: 'Claimed' }))])).resolves.toBe(1);
    expect((await Repo.transactions.get('a'))?.displayMessage).toBe('Claimed');
  });

  it("never touches this device's own row, a recovered row or a row with the same on-chain id", async () => {
    await Repo.transactions.bulkAdd([
      row('own'),
      row('recovered', { restoredFromBackup: true, recovered: true }),
      row('local', { transactionId: 'tx-shared' })
    ]);
    const written = await applyHistoryRows([
      projectTransaction(row('own', { displayMessage: 'peer' })),
      projectTransaction(row('recovered', { displayMessage: 'peer' })),
      projectTransaction(row('peer', { transactionId: 'tx-shared' }))
    ]);
    expect(written).toBe(0);
    expect((await Repo.transactions.get('own'))?.displayMessage).toBeUndefined();
    expect((await Repo.transactions.get('recovered'))?.displayMessage).toBeUndefined();
    expect(await Repo.transactions.get('peer')).toBeUndefined();
  });
});

describe('spillOverfullChunks', () => {
  const big = (id: string) => JSON.stringify({ id, pad: 'p'.repeat(10_000) });
  const rowsOf = (ids: readonly string[]) => ids.map(big);

  it('moves the last rows of an overfull closed chunk into the open chunk', () => {
    const history: HistoryState = {
      chunks: [
        { n: 0, ids: ['a', 'b', 'c'] },
        { n: 1, ids: ['d'] }
      ],
      assigned: { a: { n: 0, digest: '' }, b: { n: 0, digest: '' }, c: { n: 0, digest: '' }, d: { n: 1, digest: '' } },
      dirty: []
    };
    expect(spillOverfullChunks(history, rowsOf).sort()).toEqual([0, 1]);
    expect(history.chunks).toEqual([
      { n: 0, ids: ['a', 'b'] },
      { n: 1, ids: ['d', 'c'] }
    ]);
    expect(history.assigned.c?.n).toBe(1);
  });

  it('opens a new chunk when the overfull chunk is the open one', () => {
    const history: HistoryState = { chunks: [{ n: 0, ids: ['a', 'b', 'c'] }], assigned: {}, dirty: [] };
    spillOverfullChunks(history, rowsOf);
    expect(history.chunks).toEqual([
      { n: 0, ids: ['a', 'b'] },
      { n: 1, ids: ['c'] }
    ]);
  });

  it('changes nothing for chunks under the cap', () => {
    const history: HistoryState = { chunks: [{ n: 0, ids: ['a', 'b'] }], assigned: {}, dirty: [] };
    expect(spillOverfullChunks(history, rowsOf)).toEqual([]);
  });
});

describe('history sync', () => {
  const savedDefine = process.env.MIDEN_WALLET_API_URL;
  let removeImportShim: () => void;
  let server: FakeWalletApi;
  let restoreFetch: () => void;
  let session: BackupSession;
  let deviceId: string;

  async function chunkRows(n: number): Promise<string[]> {
    const entry = server.storedEntryOf(
      session.publicKey,
      'history',
      hashedKeyOf(session, historyEntryKey(deviceId, n))
    );
    if (entry === undefined) throw new Error(`No chunk ${n} on the server`);
    return parseHistoryChunk(await decryptEntry(session.encKey, entry, HISTORY_BLOB_CAP)).map(item => item.id);
  }

  async function insertPeerChunk(peerDevice: string, n: number, rows: unknown[]): Promise<void> {
    const entry = await encryptEntry(session.encKey, JSON.stringify(rows), session.kdfParams);
    server.insertEntry(session.publicKey, 'history', hashedKeyOf(session, historyEntryKey(peerDevice, n)), entry);
  }

  beforeAll(() => {
    delete process.env.MIDEN_WALLET_API_URL;
    removeImportShim = installCopyingImportKey();
  });

  afterAll(() => {
    if (savedDefine !== undefined) process.env.MIDEN_WALLET_API_URL = savedDefine;
    removeImportShim();
  });

  beforeEach(async () => {
    clearBackupSession();
    onBackupStorageCleared();
    server = new FakeWalletApi();
    restoreFetch = installFakeFetch(server);
    setActiveVault(new FakeVault(PHRASE_A));
    setActiveStorage(new MemoryStorage());
    const opened = await getBackupSession();
    if (!('session' in opened)) throw new Error(`No session: ${opened.unavailable}`);
    session = opened.session;
    deviceId = await getBackupDeviceId();
  });

  afterEach(() => {
    clearBackupSession();
    restoreFetch();
    jest.restoreAllMocks();
  });

  it('appends Completed rows, oldest first, to chunk 0 and uploads it once', async () => {
    await Repo.transactions.bulkAdd([
      row('late', { completedAt: 1_700_000_100 }),
      row('early', { completedAt: 1_700_000_050 }),
      row('failed', { status: ITransactionStatus.Failed }),
      row('queued', { status: ITransactionStatus.Queued }),
      row('restored', { restoredFromBackup: true })
    ]);

    await expect(flushHistory(session)).resolves.toBe(1);
    expect(session.state.history.chunks).toEqual([{ n: 0, ids: ['early', 'late'] }]);
    expect(session.state.history.dirty).toEqual([]);
    await expect(chunkRows(0)).resolves.toEqual(['early', 'late']);

    const mark = server.requests.length;
    await expect(flushHistory(session)).resolves.toBe(0);
    expect(server.requestsSince(mark)).toHaveLength(0);
  });

  it('repairs an uploaded switch receipt and updates the peer copy', async () => {
    const old = row('guardian-switch', { type: 'switch-guardian' });
    await Repo.transactions.add(old);
    await flushHistory(session);
    const endpoints = {
      previousGuardianEndpoint: 'https://old.guardian.test',
      newGuardianEndpoint: 'https://new.guardian.test'
    };
    await Repo.transactions.update(old.id, { extraInputs: endpoints });
    await expect(flushHistory(session)).resolves.toBe(1);
    const entry = server.entriesOf(session.publicKey, 'history')[0];
    if (!entry) throw new Error('Missing uploaded receipt');
    expect(entry.revision).toBe(2);
    const encrypted = server.storedEntryOf(session.publicKey, 'history', entry.hashedKey);
    if (!encrypted) throw new Error('Missing encrypted chunk');
    const repaired = parseHistoryChunk(await decryptEntry(session.encKey, encrypted, HISTORY_BLOB_CAP));
    await Repo.transactions.put(restoreTransaction(projectTransaction(old)));
    await applyHistoryRows(repaired);
    expect((await Repo.transactions.get(old.id))?.extraInputs).toEqual(endpoints);
    expect((await Repo.transactions.get(old.id))?.transactionId).toBe(old.transactionId);
  });

  it('rewrites the chunk of a row whose receipt changed', async () => {
    await Repo.transactions.add(row('swap', { type: 'swap', extraInputs: { requestedFaucetId: 'f2' } }));
    await flushHistory(session);
    await Repo.transactions.update('swap', { extraInputs: { requestedFaucetId: 'f2', settledAt: 9 } });

    await expect(flushHistory(session)).resolves.toBe(1);
    expect(server.entriesOf(session.publicKey, 'history')[0]?.revision).toBe(2);
  });

  it('closes a chunk before it passes 25 KiB less the headroom, and every chunk fits the cap', async () => {
    const rows = Array.from({ length: 20 }, (_value, index) =>
      row(`r${String(index).padStart(2, '0')}`, {
        completedAt: 1_700_000_000 + index,
        displayMessage: 'm'.repeat(3000)
      })
    );
    await Repo.transactions.bulkAdd(rows);

    const written = await flushHistory(session);
    const chunks = session.state.history.chunks;
    expect(chunks.length).toBeGreaterThan(1);
    expect(written).toBe(chunks.length);
    expect(chunks.flatMap(chunk => chunk.ids)).toEqual(rows.map(item => item.id));
    const sizes: number[] = [];
    for (const chunk of chunks) {
      const entry = server.storedEntryOf(
        session.publicKey,
        'history',
        hashedKeyOf(session, historyEntryKey(deviceId, chunk.n))
      );
      if (entry === undefined) throw new Error(`No chunk ${chunk.n}`);
      const blobBytes = b64ToU8(entry.blob).length;
      sizes.push(blobBytes);
      await expect(chunkRows(chunk.n)).resolves.toEqual(chunk.ids);
    }
    const limit = HISTORY_BLOB_CAP - CHUNK_HEADROOM_BYTES;
    // An append keeps the headroom free for later receipt changes.
    expect(sizes.every(size => size <= limit)).toBe(true);
    // A closed chunk closed because one more row (about 3.1 KB) would take it past that limit.
    expect(sizes.slice(0, -1).every(size => size + 3200 > limit)).toBe(true);
  });

  it('leaves out a row that is over the chunk cap on its own', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Repo.transactions.add(row('huge', { displayMessage: 'm'.repeat(HISTORY_BLOB_CAP) }));
    await expect(flushHistory(session)).resolves.toBe(0);
    expect(session.state.history.assigned.huge).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("applies a peer's chunk as restored rows and counts it, but never its own chunks", async () => {
    await Repo.transactions.add(row('mine'));
    await flushHistory(session);
    await expect(readHistory(session, true)).resolves.toBe(false);
    await expect(peerHistoryChunkCount(session)).resolves.toBe(0);

    await insertPeerChunk('peer-device', 0, [
      projectTransaction(row('theirs')),
      { ...projectTransaction(row('live')), s: ITransactionStatus.Queued }
    ]);
    await expect(readHistory(session, true)).resolves.toBe(true);
    expect((await Repo.transactions.get('theirs'))?.restoredFromBackup).toBe(true);
    expect(await Repo.transactions.get('live')).toBeUndefined();
    expect((await Repo.transactions.get('mine'))?.restoredFromBackup).toBeUndefined();
    await expect(peerHistoryChunkCount(session)).resolves.toBe(1);

    // A restored row is never appended to this device's own stream.
    await expect(flushHistory(session)).resolves.toBe(0);
    await expect(chunkRows(0)).resolves.toEqual(['mine']);
  });
});
