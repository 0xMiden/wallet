import { Account, NoteFile } from '@miden-sdk/miden-sdk/lazy';

import { u8ToB64 } from 'lib/shared/helpers';

import { ITransactionStatus, type ITransaction } from '../db/types';
import { readAccountChainStates } from '../guardian/recovery-verification';
import * as Repo from '../repo';
import { assessSpendingLimit } from '../spending-limits/policy';
import { judgeSubmitEvidence } from '../transaction/reconcile-judge';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Account: { deserialize: jest.fn() },
  getWasmOrThrow: async () => ({}),
  NoteFile: { deserialize: jest.fn() }
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'https://node.invalid' }));
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, mockStorage.get(key)]))
  })
}));
jest.mock('./miden-client-proxy', () => ({ midenClientProxy: { getAccount: () => mockClient.accounts.get() } }));
jest.mock('./store', () => ({
  withUnlocked: (run: (session: typeof mockSession) => Promise<unknown>) => run(mockSession),
  store: { getState: () => mockSession }
}));
jest.mock('../front/storage', () => ({
  inStorageTurn: (_key: string, run: () => Promise<unknown>) => run(),
  putToStorage: (key: string, value: unknown) => mockWriteStorage(key, value)
}));
jest.mock('../guardian/account', () => ({}));
jest.mock('../guardian/native-http', () => ({}));
jest.mock('../guardian/recovery-verification', () => ({ readAccountChainStates: jest.fn() }));
jest.mock('../sdk/helpers', () => ({ canonicalWalletAccountId: (id: string) => id }));
jest.mock('../repo', () => ({
  deserializeRecoveryTransfers: jest.fn(),
  restoreRecoveryTransfers: jest.fn(),
  serializeRecoveryTransfer: jest.fn(),
  transactions: {
    orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    where: () => ({ aboveOrEqual: () => ({ filter: () => mockSpendingHistory }) })
  },
  spendingLimits: { toArray: async () => [] },
  readWalletStoreGeneration: jest.fn(),
  writeWalletStoreGeneration: jest.fn()
}));
jest.mock('../sdk/miden-client', () => ({
  assertWasmHoldCurrent: jest.fn(),
  getMidenClient: async () => ({ client: mockClient }),
  withWasmClientLock: (run: (hold: number) => Promise<unknown>) => run(1)
}));
jest.mock('../transaction/reconcile-judge', () => ({ judgeSubmitEvidence: jest.fn() }));
jest.mock('../transaction/reconcile-reads', () => ({
  createNodeReads: async () => ({}),
  observedCadenceMs: () => 5000
}));

const accountId = 'expected-account';
const accountBytes = Uint8Array.of(1, 2);
const noteBytes = Uint8Array.of(3, 4);
const noteDetailsBytes = Uint8Array.of(5, 6);
const failureEpoch = 'storage-failure';
const retained = {
  accounts: [{ id: accountId, state: u8ToB64(accountBytes) }],
  notes: [u8ToB64(noteBytes), u8ToB64(noteDetailsBytes)],
  transfers: {},
  limits: [],
  walletStoreGeneration: 'retained-store-generation'
};
const mockStorage = new Map<string, unknown>();
const mockWriteStorage = jest.fn<Promise<void>, [string, unknown]>();
const mockJournal = { read: jest.fn(), retain: jest.fn() };
const mockSession = { accounts: [{ publicKey: accountId }], vault: { storageJournal: mockJournal } };
const mockClient = {
  accounts: { insert: jest.fn(), get: jest.fn() },
  notes: { import: jest.fn(), list: jest.fn() }
};

const noteRecord = { free: jest.fn() };
const accountKey = { toString: () => accountId };
const mockSpendingHistory = {
  limit: (count: number) => ({ toArray: async () => (await mockSpendingHistory.toArray()).slice(0, count) }),
  toArray: jest.fn<Promise<ITransaction[]>, []>()
};
const accountState = {
  id: () => accountKey,
  serialize: () => accountBytes,
  to_commitment: () => ({ toHex: () => '0xabc' }),
  free: jest.fn()
};
const noteFile = { noteType: () => 'NoteWithProof', noteId: () => 'file-note-id', free: jest.fn() };
const noteDetailsFile = { noteType: () => 'NoteDetails', noteId: () => undefined, free: jest.fn() };

let captureWalletAccounts: typeof import('./storage-recovery').captureWalletAccounts;
let rebuildWalletStorage: typeof import('./storage-recovery').rebuildWalletStorage;
let retainWalletNotes: typeof import('./storage-recovery').retainWalletNotes;
let storageHealth: typeof import('../storage-health');

beforeAll(() => {
  // Jest's setup imports the real repo and storage health before this suite installs its storage mocks.
  jest.isolateModules(() => {
    ({ captureWalletAccounts, rebuildWalletStorage, retainWalletNotes } = require('./storage-recovery'));
    storageHealth = require('../storage-health');
  });
});

beforeEach(() => {
  jest.resetAllMocks();
  mockStorage.set(storageHealth.WALLET_STORAGE_FAILURE_KEY, failureEpoch);
  mockWriteStorage.mockImplementation(async (key, value) => {
    mockStorage.set(key, value);
  });
  mockJournal.read.mockResolvedValue(retained);
  mockJournal.retain.mockImplementation(
    async (update: (data: typeof retained) => typeof retained, assertCurrent: () => void) => {
      assertCurrent();
      return update(retained);
    }
  );
  jest
    .mocked(readAccountChainStates)
    .mockResolvedValue(new Map([[accountId, { kind: 'deployed', commitment: '0xabc' }]]));
  jest.mocked(Account.deserialize).mockReturnValue(accountState as unknown as Account);
  jest
    .mocked(NoteFile.deserialize)
    .mockReturnValueOnce(noteFile as unknown as NoteFile)
    .mockReturnValueOnce(noteDetailsFile as unknown as NoteFile);
  jest.mocked(Repo.deserializeRecoveryTransfers).mockReturnValue([]);
  mockClient.accounts.get.mockResolvedValue(accountState);
  mockClient.notes.import.mockResolvedValueOnce('file-note-id').mockResolvedValueOnce('note-details-commitment');
  mockClient.notes.list.mockResolvedValue([noteRecord]);
});

it('resumes the same account only after reading back the retained files and persisting recovery', async () => {
  await expect(rebuildWalletStorage()).resolves.toEqual({
    expectedAccounts: 1,
    verifiedAccounts: 1,
    expectedNotes: 2,
    verifiedNotes: 2
  });

  expect(readAccountChainStates).toHaveBeenCalledWith([accountId]);
  expect(Account.deserialize).toHaveBeenCalledWith(accountBytes);
  expect(mockClient.accounts.insert).toHaveBeenCalledWith({ account: accountState, overwrite: true });
  expect(mockClient.accounts.get).toHaveBeenCalledWith(accountKey);
  expect(NoteFile.deserialize).toHaveBeenNthCalledWith(1, noteBytes);
  expect(NoteFile.deserialize).toHaveBeenNthCalledWith(2, noteDetailsBytes);
  expect(mockClient.notes.import).toHaveBeenNthCalledWith(1, noteFile);
  expect(mockClient.notes.import).toHaveBeenNthCalledWith(2, noteDetailsFile);
  expect(mockClient.notes.list).toHaveBeenNthCalledWith(1, { ids: ['file-note-id'] });
  expect(mockClient.notes.list).toHaveBeenNthCalledWith(2, { detailsCommitments: ['note-details-commitment'] });
  expect(Repo.writeWalletStoreGeneration).toHaveBeenCalledWith(retained.walletStoreGeneration);
  expect(mockWriteStorage).toHaveBeenCalledWith(storageHealth.WALLET_STORAGE_FAILURE_KEY, null);
  for (const step of [
    mockClient.accounts.get,
    mockClient.notes.list,
    Repo.restoreRecoveryTransfers,
    mockJournal.retain
  ]) {
    expect(jest.mocked(step).mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockWriteStorage.mock.invocationCallOrder[0]!
    );
  }
  await expect(storageHealth.getWalletStorageFailure()).resolves.toBeUndefined();
});

it('rebuilds retained private notes without importing an old ID-only pointer', async () => {
  const pointerBytes = Uint8Array.of(7, 8);
  const pointer = { noteType: () => 'NoteId', noteId: () => 'missing-note-id', free: jest.fn() };
  mockJournal.read.mockResolvedValue({ ...retained, notes: [...retained.notes, u8ToB64(pointerBytes)] });
  jest.mocked(NoteFile.deserialize).mockReturnValueOnce(pointer as unknown as NoteFile);
  mockClient.notes.import.mockRejectedValueOnce(new Error('Note not found on chain'));

  await expect(rebuildWalletStorage()).resolves.toMatchObject({ expectedNotes: 2, verifiedNotes: 2 });
  expect(mockClient.notes.import).not.toHaveBeenCalledWith(pointer);
  await expect(storageHealth.getWalletStorageFailure()).resolves.toBeUndefined();
});

it('rebuilds after verifying a retained wallet whose IndexedDB generation changed', async () => {
  jest.mocked(Repo.readWalletStoreGeneration).mockResolvedValue('different-active-generation');
  jest.mocked(Repo.writeWalletStoreGeneration).mockRejectedValue(new Error('Wallet storage generation changed'));

  await expect(rebuildWalletStorage()).resolves.toMatchObject({ verifiedAccounts: 1, verifiedNotes: 2 });
  await expect(storageHealth.getWalletStorageFailure()).resolves.toBeUndefined();
});

it('acknowledges an incoming ID-only pointer without turning it into mandatory recovery data', async () => {
  const pointer = {
    noteType: () => 'NoteId',
    noteId: () => 'missing-pointer',
    free: jest.fn()
  };
  jest
    .mocked(NoteFile.deserialize)
    .mockReset()
    .mockReturnValue(pointer as unknown as NoteFile);

  await expect(retainWalletNotes([u8ToB64(Uint8Array.of(7, 8))], 'https://node.invalid')).resolves.toBeUndefined();

  expect(pointer.free).toHaveBeenCalledTimes(1);
  expect(mockJournal.retain).not.toHaveBeenCalled();

  jest.mocked(NoteFile.deserialize).mockReturnValueOnce(pointer as unknown as NoteFile);
  jest.mocked(NoteFile.deserialize).mockReturnValueOnce(noteFile as unknown as NoteFile);
  const proof = u8ToB64(noteBytes);
  const save = mockJournal.retain.mockImplementation(async change => change({ ...retained, notes: [] }));
  await retainWalletNotes([u8ToB64(Uint8Array.of(7, 8)), proof], 'https://node.invalid');

  expect((await save.mock.results[0].value).notes).toEqual([proof]);
});

it('drops old pointers during capture and retains a full proof over the matching expected note', async () => {
  const proof = { ...noteFile, detailsCommitment: () => 'same-details' };
  const expected = { ...noteDetailsFile, detailsCommitment: proof.detailsCommitment };
  const pointer = { noteType: () => 'NoteId', noteId: () => 'missing-pointer', free: jest.fn() };
  const files = [proof, expected, pointer];
  const previous = { ...retained, notes: files.map((_, index) => u8ToB64(Uint8Array.of(index))) };
  jest
    .mocked(NoteFile.deserialize)
    .mockReset()
    .mockImplementation(bytes => files[bytes[0]!] as unknown as NoteFile);
  jest.mocked(Repo.readWalletStoreGeneration).mockResolvedValue(retained.walletStoreGeneration);
  mockJournal.read.mockResolvedValue(previous);
  mockSpendingHistory.toArray.mockResolvedValue([]);
  const save = mockJournal.retain.mockImplementation(async change => change(previous));

  await captureWalletAccounts(
    mockSession.vault as unknown as Parameters<typeof captureWalletAccounts>[0],
    mockSession.accounts as Parameters<typeof captureWalletAccounts>[1],
    () => {}
  );

  expect((await save.mock.results[0].value).notes).toEqual([previous.notes[0]]);
});

it('retains compact recent spending records beyond the old cap with the same spend total', async () => {
  const now = Math.floor(Date.now() / 1000);
  const spending = Array.from(
    { length: 258 },
    (_, index): ITransaction => ({
      id: `spend-${index}`,
      type: 'send',
      accountId,
      initiatedAt: now - index,
      status: ITransactionStatus.Completed,
      displayIcon: 'SEND',
      spentUsd: BigInt(index + 1)
    })
  );
  mockSpendingHistory.toArray.mockResolvedValue(spending);
  jest.mocked(Repo.readWalletStoreGeneration).mockResolvedValue(retained.walletStoreGeneration);
  const recoveryCodec = jest.requireActual<typeof Repo>('../repo');
  jest.mocked(Repo.serializeRecoveryTransfer).mockImplementation(recoveryCodec.serializeRecoveryTransfer);
  const save = mockJournal.retain.mockImplementation(async change => change({ ...retained, notes: [] }));

  await expect(
    captureWalletAccounts(
      mockSession.vault as unknown as Parameters<typeof captureWalletAccounts>[0],
      mockSession.accounts as Parameters<typeof captureWalletAccounts>[1],
      () => {}
    )
  ).resolves.toBeUndefined();

  const saved = await save.mock.results[0].value;
  const recovered = recoveryCodec.deserializeRecoveryTransfers(saved.transfers, id => id === accountId);
  const cap = { accountId, limit: 1n, revision: '1', createdAt: now, updatedAt: now };
  const proposal = { accountId, usdAmount: 1n, now };
  expect(recovered).toHaveLength(spending.length);
  expect(assessSpendingLimit(cap, recovered, proposal).breach?.spent).toBe(
    assessSpendingLimit(cap, spending, proposal).breach?.spent
  );
});

it('stays paused if the note import leaves no readable record', async () => {
  mockClient.notes.list.mockResolvedValueOnce([]);

  await expect(rebuildWalletStorage()).rejects.toThrow(storageHealth.WalletStorageUnavailableError);

  expect(mockClient.notes.import).toHaveBeenCalledWith(noteFile);
  expect(Repo.restoreRecoveryTransfers).not.toHaveBeenCalled();
  await expect(storageHealth.getWalletStorageFailure()).resolves.toBe(failureEpoch);
});

it('stays paused if the account read from the rebuilt store has a different commitment', async () => {
  mockClient.accounts.get.mockResolvedValue({ ...accountState, to_commitment: () => ({ toHex: () => '0xdef' }) });

  await expect(rebuildWalletStorage()).rejects.toThrow(storageHealth.WalletStorageUnavailableError);

  expect(mockClient.accounts.insert).toHaveBeenCalled();
  expect(Repo.restoreRecoveryTransfers).not.toHaveBeenCalled();
  await expect(storageHealth.getWalletStorageFailure()).resolves.toBe(failureEpoch);
});

it('keeps a potentially submitted transfer paused until the node can determine its outcome', async () => {
  const transfer: ITransaction = {
    id: 'transfer',
    type: 'send',
    accountId,
    displayIcon: 'SEND',
    initiatedAt: 1,
    status: ITransactionStatus.Unconfirmed,
    mayHaveSubmitted: true
  };
  jest.mocked(Repo.deserializeRecoveryTransfers).mockReturnValue([transfer]);
  jest.mocked(judgeSubmitEvidence).mockResolvedValue({
    rowId: transfer.id,
    judgedEntries: [],
    entries: [],
    allDead: false,
    landingHeld: false
  });

  await expect(rebuildWalletStorage()).rejects.toThrow(storageHealth.WalletStorageUnavailableError);

  expect(judgeSubmitEvidence).toHaveBeenCalledWith(transfer, expect.objectContaining({ accountRows: [transfer] }));
  expect(mockClient.accounts.insert).not.toHaveBeenCalled();
  expect(Repo.restoreRecoveryTransfers).not.toHaveBeenCalled();
  await expect(storageHealth.getWalletStorageFailure()).resolves.toBe(failureEpoch);
});

it('stays paused if the verified rebuild cannot be written to the recovery journal', async () => {
  mockJournal.retain.mockRejectedValue(new DOMException('No space left', 'QuotaExceededError'));

  await expect(rebuildWalletStorage()).rejects.toThrow('No space left');

  expect(mockClient.accounts.get).toHaveBeenCalledWith(accountKey);
  expect(Repo.writeWalletStoreGeneration).toHaveBeenCalledWith(retained.walletStoreGeneration);
  await expect(storageHealth.getWalletStorageFailure()).resolves.toBe(failureEpoch);
});
