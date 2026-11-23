import Dexie from 'dexie';

import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { readsAsNotConfirmed } from 'lib/miden/transaction/submission-feedback';
import { NoteTypeEnum } from 'lib/miden/types';
import { b64ToU8 } from 'lib/shared/helpers';

import { HISTORY_BLOB_CAP, decryptEntry, encryptEntry } from '../crypto';
import { hashedKeyOf } from '../entries';
import { type BackupSession, BackupSessionClosedError, clearBackupSession, getBackupSession } from '../session';
import { type HistoryState, getBackupDeviceId, onBackupStorageCleared } from '../state';
import {
  CHUNK_HEADROOM_BYTES,
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
  getActiveStorage,
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

  it('appends only terminal rows of this device', () => {
    expect(isAppendableRow(row('a'))).toBe(true);
    expect(isAppendableRow(row('a', { status: ITransactionStatus.Failed }))).toBe(true);
    expect(isAppendableRow(row('a', { status: ITransactionStatus.Unconfirmed }))).toBe(true);
    expect(isAppendableRow(row('a', { restoredFromBackup: true }))).toBe(false);
    expect(isAppendableRow(row('a', { recovered: true }))).toBe(false);
  });

  it('projects a row with unix ms, decimal amounts and all note ids', () => {
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
    expect(projected.n).toHaveLength(notes.length);
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

  it('preserves fee, asset, note, origin, and outcome fields through the stored JSON', () => {
    const original = row('receipt', {
      type: 'consume',
      status: ITransactionStatus.Unconfirmed,
      feeFaucetId: 'fee-faucet',
      feeAmount: 2n,
      noteType: NoteTypeEnum.Private,
      noteDelivery: 'confirmed',
      dappOrigins: ['https://app.example'],
      inputNoteIds: ['input'],
      noteIds: ['input'],
      outputNoteIds: ['change'],
      assetTotals: [{ faucetId: 'f2', amount: 9n }],
      error: 'Submission interrupted',
      extraInputs: {
        swapOrderTxId: 'swap',
        swapSettleKind: 'reclaim',
        bridgeIn: { provider: 'epoch', bridgeReceiveTxId: 'bridge', midenNoteId: 'input' }
      }
    });
    const [stored] = parseHistoryChunk(JSON.stringify([projectTransaction(original)]));
    if (!stored) throw new Error('The backup receipt must parse');
    const restored = restoreTransaction(stored);
    expect(restored).toMatchObject({
      feeFaucetId: original.feeFaucetId,
      feeAmount: original.feeAmount,
      noteType: original.noteType,
      noteDelivery: original.noteDelivery,
      dappOrigins: original.dappOrigins,
      inputNoteIds: original.inputNoteIds,
      assetTotals: original.assetTotals,
      error: original.error,
      outputNoteIds: original.outputNoteIds,
      extraInputs: original.extraInputs,
      restoredFromBackup: true
    });
    expect(readsAsNotConfirmed(restored)).toBe(true);
  });

  it('keeps swap status and Guardian verdict details without retaining request bytes', () => {
    const order = restoreTransaction(
      projectTransaction(
        row('order', {
          type: 'swap',
          extraInputs: { expiresAt: 123, orderId: 12n, autoConsume: true, requestBytes: [1, 2] }
        })
      )
    );
    expect(order.extraInputs).toMatchObject({ orderId: '12', expiresAt: 123, autoConsume: true });
    expect(order.extraInputs).not.toHaveProperty('requestBytes');
    const switched = restoreTransaction(
      projectTransaction(
        row('switch', { type: 'switch-guardian', extraInputs: { commitUnconfirmed: true, registerFailed: true } })
      )
    );
    expect(switched.extraInputs).toMatchObject({ commitUnconfirmed: true, registerFailed: true });
  });

  it('keeps the exact USDCx payout and CCTP progress without a balance snapshot or attestation', () => {
    const restoredSend = restoreTransaction(
      projectTransaction(
        row('burn', {
          type: 'bridged-send',
          extraInputs: {
            intentNonce: 'intent',
            epochStatus: 'confirmed',
            outputAmount: '1.2',
            usdcxBurn: {
              noteId: 'burn-note',
              destinationDomain: 1,
              phase: 'confirmed',
              destinationBalanceBefore: { balance: '100', blockNumber: '3' },
              payout: { transactionHash: '0xabc', blockNumber: '4', value: '90' }
            }
          }
        })
      )
    );
    expect(restoredSend.extraInputs).toMatchObject({
      intentNonce: 'intent',
      epochStatus: 'confirmed',
      outputAmount: '1.2',
      usdcxBurn: { payout: { transactionHash: '0xabc', value: '90' } }
    });
    expect(restoredSend.extraInputs).not.toHaveProperty('usdcxBurn.destinationBalanceBefore');

    const restoredDeposit = restoreTransaction(
      projectTransaction(
        row('deposit', {
          type: 'bridged-receive',
          extraInputs: {
            cctp: { sourceDomain: 1, attestation: 'proof', forwardFee: '15' },
            epochLockedDeposit: {
              sponsorAddress: '0xabc',
              chainId: 1,
              withdrawnAt: 50,
              intentData: { request: 'private' }
            }
          }
        })
      )
    );
    expect(restoredDeposit.extraInputs).toMatchObject({
      cctp: { receiptBurnAttested: true, forwardFee: '15' },
      epochLockedDeposit: { sponsorAddress: '0xabc', chainId: 1, withdrawnAt: 50 }
    });
    expect(restoredDeposit.extraInputs).not.toHaveProperty('cctp.attestation');
    expect(restoredDeposit.extraInputs).not.toHaveProperty('epochLockedDeposit.intentData');
  });

  it('keeps NEAR Intents receipt fields without provider credentials or signed request data', () => {
    const asset = { blockchain: 'sol', symbol: 'USDC', decimals: 6 };
    const original = row('near', {
      type: 'bridged-receive',
      extraInputs: {
        oneClick: {
          direction: 'evm-to-miden',
          phase: 'delivered',
          network: 'mainnet',
          amount: '150',
          originAsset: asset,
          destinationAsset: { ...asset, blockchain: 'miden' },
          config: { serviceUrl: 'https://provider.example', chains: [{ id: 'sol', name: 'Solana' }] },
          request: { refundTo: 'sender' },
          quote: { signature: 'signed', quote: { amountIn: '160', amountOut: '150', minAmountOut: '140' } },
          statusResponse: {
            swapDetails: { originChainTxHashes: [{ hash: 'id', explorerUrl: 'https://explorer.example/id' }] }
          }
        }
      }
    });
    const [stored] = parseHistoryChunk(JSON.stringify([projectTransaction(original)]));
    if (!stored) throw new Error('The backup receipt must parse');
    const restored = restoreTransaction(stored);
    expect(restored.extraInputs).toMatchObject({
      oneClick: {
        phase: 'delivered',
        config: { chains: [{ id: 'sol', name: 'Solana' }] },
        quote: { quote: { minAmountOut: '140' } },
        statusResponse: { swapDetails: { originChainTxHashes: [{ hash: 'id' }] } }
      }
    });
    expect(restored.extraInputs).not.toHaveProperty('oneClick.quote.signature');
    expect(restored.extraInputs).not.toHaveProperty('oneClick.config.serviceUrl');
  });

  it('restores the delivery note ID of an Earn withdrawal', () => {
    const withdrawal = row('withdrawal', {
      type: 'earn-withdraw',
      extraInputs: { phase: 'received', midenNoteId: '0x1234' }
    });
    const restored = restoreTransaction(projectTransaction(withdrawal));
    expect(restored.extraInputs).toMatchObject({ phase: 'received', midenNoteId: '0x1234' });
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
      reclaimedAt: 1
    });
  });

  it.each([
    ['a Queued row', { s: ITransactionStatus.Queued }],
    ['a generating row', { s: ITransactionStatus.GeneratingTransaction }],
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

  it.each([false, true])('restores a bridge and its claim in either order (reversed: %s)', async reversed => {
    const bridge = row('bridge', {
      type: 'bridged-receive',
      transactionId: 'shared',
      extraInputs: { provider: 'epoch', phase: 'received', midenNoteId: 'note' }
    });
    const consume = row('claim', {
      type: 'consume',
      transactionId: 'shared',
      noteIds: ['note'],
      extraInputs: { bridgeIn: { provider: 'epoch', bridgeReceiveTxId: 'bridge' } }
    });
    const projected = (reversed ? [consume, bridge] : [bridge, consume]).map(projectTransaction);
    await expect(applyHistoryRows(projected)).resolves.toBe(2);
    expect(await Repo.transactions.get('bridge')).toMatchObject({ type: 'bridged-receive', restoredFromBackup: true });
    expect(await Repo.transactions.get('claim')).toMatchObject({
      extraInputs: { bridgeIn: { bridgeReceiveTxId: 'bridge' } }
    });
  });

  it('keeps each bridge delivery in a shared batch claim', async () => {
    const receipts = ['note-a', 'note-b', 'note-a'].map((note, index) =>
      projectTransaction(
        row(`bridge-${index}`, {
          type: 'bridged-receive',
          transactionId: 'batch-claim',
          extraInputs: { provider: 'epoch', phase: 'received', midenNoteId: note }
        })
      )
    );
    await expect(applyHistoryRows(receipts)).resolves.toBe(2);
    expect((await Repo.transactions.toArray()).map(tx => tx.id)).toEqual(['bridge-0', 'bridge-1']);
  });

  it('replaces a generic Guardian receipt when the exact note set arrives in a peer backup', async () => {
    await Repo.transactions.add(
      row('guardian-claim', { type: 'consume', noteIds: ['0xAB'], recovered: true, restoredFromBackup: true })
    );
    const receipt = row('peer-claim', { type: 'consume', noteIds: ['ab'], displayMessage: 'Bridged from EVM' });
    await expect(applyHistoryRows([projectTransaction(receipt)])).resolves.toBe(1);
    expect(await Repo.transactions.get('guardian-claim')).toBeUndefined();
    expect(await Repo.transactions.get('peer-claim')).toMatchObject({ displayMessage: 'Bridged from EVM' });
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

describe('a malformed peer swap amount', () => {
  const swap = (id: string, ra: unknown) => ({
    ...projectTransaction(row(id, { type: 'swap' })),
    x: { rf: 'faucet', ra }
  });

  // The restore reads x.ra with BigInt inside the apply transaction, so a value the projection never writes
  // would roll back the whole read on every attempt.
  it('drops only that row, and the rest of its chunk restores', async () => {
    const chunk = JSON.stringify([
      projectTransaction(row('before')),
      swap('bad', 'abc'),
      projectTransaction(row('after'))
    ]);
    await expect(applyHistoryRows(parseHistoryChunk(chunk))).resolves.toBe(2);
    expect(await Repo.transactions.get('before')).toBeDefined();
    expect(await Repo.transactions.get('after')).toBeDefined();
    expect(await Repo.transactions.get('bad')).toBeUndefined();
  });

  it.each(['abc', '1.5', '0x10', '', 7])('refuses x.ra %p', ra => {
    expect(parseHistoryRow(swap('s', ra))).toBeNull();
  });

  it('keeps a decimal x.ra and a swap without one', () => {
    expect(parseHistoryRow(swap('s', '42'))?.x).toEqual({ rf: 'faucet', ra: '42' });
    expect(parseHistoryRow({ ...projectTransaction(row('t', { type: 'swap' })), x: { rf: 'faucet' } })).not.toBeNull();
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

  it('a flush that waited past a storage wipe writes no backup state and uploads nothing', async () => {
    await Repo.transactions.bulkAdd([row('a')]);
    const flush = flushHistory(session);
    // The wipe: a new, empty storage for the next wallet.
    setActiveStorage(new MemoryStorage());
    onBackupStorageCleared();
    await expect(flush).rejects.toBeInstanceOf(BackupSessionClosedError);
    expect(getActiveStorage().has('backup_state_v1')).toBe(false);
    expect(server.entriesOf(session.publicKey, 'history')).toHaveLength(0);
  });

  // Every completed row signals a flush, and each pass reads and projects the whole history.
  it('coalesces flush requests made while a flush runs into one more pass, which sees the new rows', async () => {
    await Repo.transactions.bulkAdd([row('a')]);
    const bulkGet = Repo.transactions.bulkGet.bind(Repo.transactions);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const passes = jest
      .spyOn(Repo.transactions, 'bulkGet')
      .mockImplementationOnce(keys => Dexie.Promise.resolve(gate).then(() => bulkGet(keys)));
    const first = flushHistory(session);
    while (passes.mock.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 0));

    await Repo.transactions.add(row('b'));
    const later = Array.from({ length: 10 }, () => flushHistory(session));
    release();
    await Promise.all([first, ...later]);

    expect(passes).toHaveBeenCalledTimes(2);
    expect(await chunkRows(0)).toEqual(['a', 'b']);
  });

  it('runs a flush requested after a failed pass', async () => {
    jest.spyOn(Repo.transactions, 'bulkGet').mockRejectedValueOnce(new Error('db'));
    await expect(flushHistory(session)).rejects.toThrow('db');
    await Repo.transactions.add(row('a'));
    await expect(flushHistory(session)).resolves.toBe(1);
  });

  it('appends receipt rows, oldest first, to chunk 0 and uploads it once', async () => {
    await Repo.transactions.bulkAdd([
      row('late', { completedAt: 1_700_000_100 }),
      row('early', { completedAt: 1_700_000_050 }),
      row('failed', { status: ITransactionStatus.Failed }),
      row('queued', { status: ITransactionStatus.Queued }),
      row('restored', { restoredFromBackup: true })
    ]);

    await expect(flushHistory(session)).resolves.toBe(1);
    expect(session.state.history.chunks).toEqual([{ n: 0, ids: ['failed', 'early', 'late'] }]);
    expect(session.state.history.dirty).toEqual([]);
    await expect(chunkRows(0)).resolves.toEqual(['failed', 'early', 'late']);

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
