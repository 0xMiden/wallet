/**
 * Two devices with one recovery phrase, against one in-memory wallet-api.
 *
 * Each device has its own vault, platform storage, device id and transaction
 * table. The realm holds one device at a time: {@link use} locks the backup,
 * parks the transaction rows of the old device and loads the rows of the new
 * one. Every backup module runs as in production, with the production scrypt
 * parameters; only the vault, the storage and `fetch` are test doubles.
 */
import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { WalletAccount, WalletContact } from 'lib/shared/types';

import { deleteBackupProfile, onBackupLock, restoreHistoryFromBackup, runBackupRefresh } from './refresh';
import { getBackupSession } from './session';
import { onBackupStorageCleared, readBackupState } from './state';
import {
  FakeVault,
  FakeWalletApi,
  MemoryStorage,
  PHRASE_A,
  PHRASE_B,
  installCopyingImportKey,
  installFakeFetch,
  makeAccount,
  setActiveStorage,
  setActiveVault
} from './testing/backup-harness';

jest.mock('lib/miden/back/store', () => {
  const harness = jest.requireActual<typeof import('./testing/backup-harness')>('./testing/backup-harness');
  return {
    store: { getState: () => harness.fakeStoreState() },
    isUnlocked: harness.isFakeUnlocked,
    accountsUpdated: jest.fn(),
    settingsUpdated: jest.fn()
  };
});
jest.mock('lib/platform/storage-adapter', () => {
  const harness = jest.requireActual<typeof import('./testing/backup-harness')>('./testing/backup-harness');
  return { getStorageProvider: () => harness.getActiveStorage() };
});
jest.mock('lib/remote-config/runtime', () => ({
  initBridgeConfig: jest.fn(async () => undefined),
  getBridgeConfigSnapshot: jest.fn()
}));
jest.mock('lib/remote-config/values', () => ({ getBackupBaseUrl: jest.fn(() => 'https://wallet-api.test') }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn() }));

interface Device {
  vault: FakeVault;
  storage: MemoryStorage;
  /** The transaction rows of this device while another device holds the realm. */
  rows: ITransaction[];
}

const savedDefine = process.env.MIDEN_WALLET_API_URL;
let removeImportShim: () => void;
let server: FakeWalletApi;
let restoreFetch: () => void;
let active: Device | null = null;

function device(
  phrase: string,
  accounts: WalletAccount[] = [],
  contacts: WalletContact[] = [],
  rows: ITransaction[] = []
): Device {
  return { vault: new FakeVault(phrase, accounts, contacts), storage: new MemoryStorage(), rows };
}

function contact(name: string, address: string): WalletContact {
  return { name, address, addedAt: 1 };
}

function completedRow(id: string, completedAt: number): ITransaction {
  return {
    id,
    type: 'send',
    accountId: 'acc-1',
    status: ITransactionStatus.Completed,
    initiatedAt: completedAt - 5,
    completedAt,
    displayIcon: 'SEND',
    transactionId: `tx-${id}`,
    secondaryAccountId: 'acc-2',
    faucetId: 'faucet-1',
    amount: 1000n,
    requestBytes: new Uint8Array([1, 2, 3])
  };
}

/** Give the realm to `target`: lock the backup, swap the vault, the storage and the transaction table. */
async function use(target: Device): Promise<void> {
  if (active !== null) active.rows = await Repo.transactions.toArray();
  await Repo.transactions.clear();
  onBackupLock();
  onBackupStorageCleared();
  setActiveVault(target.vault);
  setActiveStorage(target.storage);
  if (target.rows.length > 0) await Repo.transactions.bulkAdd(target.rows);
  active = target;
}

async function publicKeyOf(target: Device): Promise<string> {
  const publicKey = await target.vault.syncPublicKey();
  if (publicKey === null) throw new Error('No sync key');
  return publicKey;
}

function described(mark: number): string[] {
  return server
    .requestsSince(mark)
    .map(request => `${request.method} ${request.path}${request.query.after ? ' (next page)' : ''} ${request.status}`);
}

/** Refresh until a foreground refresh is a single 304, and give that refresh's requests. */
async function settleThenForeground(): Promise<{ outcome: string; requests: string[] }> {
  await runBackupRefresh('foreground');
  await runBackupRefresh('foreground');
  const mark = server.requests.length;
  const outcome = await runBackupRefresh('foreground');
  return { outcome, requests: described(mark) };
}

beforeAll(() => {
  delete process.env.MIDEN_WALLET_API_URL;
  removeImportShim = installCopyingImportKey();
});

afterAll(() => {
  if (savedDefine !== undefined) process.env.MIDEN_WALLET_API_URL = savedDefine;
  removeImportShim();
});

beforeEach(() => {
  active = null;
  server = new FakeWalletApi();
  restoreFetch = installFakeFetch(server);
  jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
});

afterEach(() => {
  onBackupLock();
  restoreFetch();
  jest.restoreAllMocks();
});

describe('two devices, one recovery phrase', () => {
  it("applies device A's renamed account and new contact on device B's unlock", async () => {
    const a = device(
      PHRASE_A,
      [makeAccount('Main', 0), makeAccount('Imported', -1, 'pk-imp')],
      [contact('Alice', 'mtst1alice')]
    );
    const b = device(PHRASE_A, [makeAccount('Account 1', 0)], []);

    await use(a);
    await expect(runBackupRefresh('unlock')).resolves.toBe('unchanged');
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    a.vault.accounts[0] = makeAccount('Savings', 0);
    a.vault.settings = { contacts: [contact('Alice', 'mtst1alice'), contact('Bob', 'mtst1bob')] };
    await runBackupRefresh('contacts-changed');
    await runBackupRefresh('foreground');

    await use(b);
    await expect(runBackupRefresh('unlock')).resolves.toBe('updated');
    expect(b.vault.nameAt(0)).toBe('Savings');
    expect(b.vault.accounts).toHaveLength(1);
    expect(b.vault.contactPairs()).toEqual([
      ['Alice', 'mtst1alice'],
      ['Bob', 'mtst1bob']
    ]);
    // Both devices share one profile and one key generation.
    const opened = await getBackupSession();
    expect('session' in opened && opened.session.salt).toBe(server.profileOf(await publicKeyOf(a))?.salt);
  });

  it("keeps both devices' contact edits through the three-way merge", async () => {
    const a = device(PHRASE_A, [], [contact('Alice', 'mtst1alice'), contact('Bob', 'mtst1bob')]);
    const b = device(PHRASE_A);
    await use(a);
    await runBackupRefresh('unlock');
    await use(b);
    await runBackupRefresh('unlock');
    expect(b.vault.contactPairs()).toHaveLength(2);

    // A adds Carol. B, which has not read since, removes Alice and renames Bob.
    await use(a);
    a.vault.settings = { contacts: [...(a.vault.settings.contacts ?? []), contact('Carol', 'mtst1carol')] };
    await runBackupRefresh('contacts-changed');
    await use(b);
    b.vault.settings = { contacts: [contact('Robert', 'mtst1bob')] };
    await expect(runBackupRefresh('contacts-changed')).resolves.toBe('updated');
    expect(b.vault.contactPairs()).toEqual([
      ['Robert', 'mtst1bob'],
      ['Carol', 'mtst1carol']
    ]);

    await use(a);
    await expect(runBackupRefresh('address-book')).resolves.toBe('updated');
    expect(a.vault.contactPairs()).toEqual([
      ['Robert', 'mtst1bob'],
      ['Carol', 'mtst1carol']
    ]);
  });

  it("lands device A's history on device B as restored rows", async () => {
    const a = device(PHRASE_A, [], [], [completedRow('a-1', 1_700_000_100), completedRow('a-2', 1_700_000_200)]);
    const b = device(PHRASE_A, [], [], [completedRow('b-1', 1_700_000_150)]);

    await use(a);
    await expect(runBackupRefresh('transaction-completed')).resolves.toBe('updated');
    // A's own chunks are not a peer's history.
    await expect(restoreHistoryFromBackup()).resolves.toBe(false);

    await use(b);
    await expect(restoreHistoryFromBackup()).resolves.toBe(true);
    const restored = await Repo.transactions.get('a-1');
    expect(restored).toMatchObject({ restoredFromBackup: true, status: ITransactionStatus.Completed, amount: 1000n });
    expect(restored?.requestBytes).toBeUndefined();
    expect((await Repo.transactions.get('b-1'))?.restoredFromBackup).toBeUndefined();

    // B uploads only its own row; A then reads it on Activity open.
    await runBackupRefresh('transaction-completed');
    await use(a);
    await expect(runBackupRefresh('activity-open')).resolves.toBe('updated');
    expect((await Repo.transactions.get('b-1'))?.restoredFromBackup).toBe(true);
    expect((await Repo.transactions.get('a-1'))?.restoredFromBackup).toBeUndefined();
  });

  it('finds no peer history on a fresh profile', async () => {
    const fresh = device(PHRASE_B, [], [], [completedRow('c-1', 1_700_000_100)]);
    await use(fresh);
    await expect(restoreHistoryFromBackup()).resolves.toBe(false);
    expect(server.profileOf(await publicKeyOf(fresh))?.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reads nothing more after a 304 on the storage index', async () => {
    const a = device(
      PHRASE_A,
      [makeAccount('Main', 0)],
      [contact('Alice', 'mtst1alice')],
      [completedRow('a-1', 1_700_000_100)]
    );
    const b = device(PHRASE_A, [makeAccount('Main', 0)]);
    await use(a);
    await runBackupRefresh('unlock');
    await use(b);
    await runBackupRefresh('unlock');

    const settled = await settleThenForeground();
    expect(settled.outcome).toBe('unchanged');
    expect(settled.requests).toEqual(['GET /v1/storage 304']);
  });

  it("reads a feature across pages and keeps the first page's ETag", async () => {
    server.pageSize = 2;
    const names = ['One', 'Two', 'Three', 'Four', 'Five'];
    const a = device(
      PHRASE_A,
      names.map((name, index) => makeAccount(name, index))
    );
    const b = device(
      PHRASE_A,
      names.map((_name, index) => makeAccount(`Account ${index + 1}`, index))
    );
    await use(a);
    await runBackupRefresh('unlock');
    const publicKey = await publicKeyOf(a);
    const [firstKey] = server.entriesOf(publicKey, 'accounts');
    if (firstKey === undefined) throw new Error('No account entries');

    await use(b);
    // A peer write lands between B's first and second page, on an entry of the first page.
    let wrote = false;
    server.onRequest = request => {
      if (!wrote && request.path === '/v1/storage/accounts' && request.query.after !== undefined) {
        wrote = true;
        server.rewriteEntry(publicKey, 'accounts', firstKey.hashedKey);
      }
    };
    const mark = server.requests.length;
    await expect(runBackupRefresh('unlock')).resolves.toBe('updated');
    server.onRequest = null;
    expect(names.map((_name, index) => b.vault.nameAt(index))).toEqual(names);

    const reads = server.requestsSince(mark).filter(request => request.path === '/v1/storage/accounts');
    const pages = reads.filter(request => request.method === 'GET');
    expect(pages.map(request => request.query.after === undefined)).toEqual([true, false, false]);
    const stored = readBackupState(b.storage.read('backup_state_v1'));
    expect(stored?.features.accounts.etag).toBe(pages[0]?.etag);
    expect(stored?.features.accounts.etag).not.toBe(server.featureEtagOf(publicKey, 'accounts'));

    // The next refresh reads the feature again (a 200, not a 304) and finds the write it missed.
    const next = server.requests.length;
    await runBackupRefresh('foreground');
    const again = server.requestsSince(next).find(request => request.path === '/v1/storage/accounts');
    expect(again).toMatchObject({ method: 'GET', ifNoneMatch: pages[0]?.etag, status: 200 });
    expect(
      readBackupState(b.storage.read('backup_state_v1'))?.features.accounts.entries[firstKey.hashedKey]?.revision
    ).toBe(2);
  });

  it('starts a deleted profile again under a new salt from the next device that unlocks', async () => {
    const a = device(PHRASE_A, [makeAccount('Main', 0)], [contact('Alice', 'mtst1alice')]);
    const b = device(PHRASE_A, [makeAccount('Main', 0)], [contact('Bob', 'mtst1bob')]);
    await use(a);
    await runBackupRefresh('unlock');
    const publicKey = await publicKeyOf(a);
    const oldSalt = server.profileOf(publicKey)?.salt;

    await expect(deleteBackupProfile()).resolves.toBe('updated');
    expect(server.profileOf(publicKey)).toBeUndefined();
    expect(a.storage.has('backup_state_v1')).toBe(false);

    await use(b);
    await runBackupRefresh('unlock');
    const newSalt = server.profileOf(publicKey)?.salt;
    expect(newSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(newSalt).not.toBe(oldSalt);
    // Only B's data is on the new profile: A's contact went with the old one.
    expect(b.vault.contactPairs()).toEqual([['Bob', 'mtst1bob']]);

    await use(a);
    await runBackupRefresh('unlock');
    expect(a.vault.contactPairs()).toEqual([
      ['Bob', 'mtst1bob'],
      ['Alice', 'mtst1alice']
    ]);
  });
});
