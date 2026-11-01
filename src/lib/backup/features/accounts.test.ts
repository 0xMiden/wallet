import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import { accountsUpdated } from 'lib/miden/back/store';
import { WalletType } from 'screens/onboarding/types';

import { encryptEntry } from '../crypto';
import { hashedKeyOf } from '../entries';
import { type BackupSession, BackupSessionClosedError, clearBackupSession, getBackupSession } from '../session';
import { onBackupStorageCleared } from '../state';
import {
  type AccountEntry,
  accountEntryKey,
  accountTypeCode,
  isSyncedAccount,
  parseAccountEntry,
  projectAccount,
  syncAccounts
} from './accounts';
import {
  FakeVault,
  FakeWalletApi,
  MemoryStorage,
  PHRASE_A,
  installCopyingImportKey,
  installFakeFetch,
  makeAccount,
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

const ENTRY: AccountEntry = { v: 1, i: 0, t: 'guardian', n: 'Main', nlu: 0, as: 'falcon', ge: null, dt: null };

describe('account projection', () => {
  it('maps the wallet types to the #850 codes', () => {
    expect(accountTypeCode(WalletType.OnChain)).toBe('onchain');
    expect(accountTypeCode(WalletType.OffChain)).toBe('offchain');
    expect(accountTypeCode(WalletType.Guardian)).toBe('guardian');
    expect(accountEntryKey('guardian', 3)).toBe('guardian:3');
  });

  it('syncs only the accounts the phrase derives', () => {
    expect(isSyncedAccount(makeAccount('A', 0))).toBe(true);
    expect(isSyncedAccount(makeAccount('A', -1))).toBe(false);
    expect(isSyncedAccount(makeAccount('A', 1.5))).toBe(false);
  });

  it('projects a Guardian account with its endpoint and no tombstone', () => {
    expect(projectAccount(makeAccount('Main', 2), 77)).toEqual({
      v: 1,
      i: 2,
      t: 'guardian',
      n: 'Main',
      nlu: 77,
      as: 'falcon',
      ge: 'https://guardian.test',
      dt: null
    });
    const onChain = { ...makeAccount('Old', 1), type: WalletType.OnChain };
    expect(projectAccount(onChain, 0).ge).toBeNull();
  });

  it('parses an entry it wrote', () => {
    expect(parseAccountEntry(JSON.stringify(ENTRY))).toEqual(ENTRY);
    expect(parseAccountEntry(JSON.stringify({ ...ENTRY, ge: 'https://g', dt: 5 }))).toEqual({
      ...ENTRY,
      ge: 'https://g',
      dt: 5
    });
  });

  it.each([
    ['a body that is not JSON', '{'],
    ['another version', JSON.stringify({ ...ENTRY, v: 2 })],
    ['an unknown type code', JSON.stringify({ ...ENTRY, t: 'imported' })],
    ['an unknown auth scheme', JSON.stringify({ ...ENTRY, as: 'rsa' })],
    ['a negative index', JSON.stringify({ ...ENTRY, i: -1 })],
    ['a name that is not a string', JSON.stringify({ ...ENTRY, n: 3 })],
    ['an nlu that is not an integer', JSON.stringify({ ...ENTRY, nlu: 'now' })],
    ['an endpoint that is not a string', JSON.stringify({ ...ENTRY, ge: 1 })],
    ['a tombstone that is not a time', JSON.stringify({ ...ENTRY, dt: 'yes' })]
  ])('refuses %s', (_name, plaintext) => {
    expect(parseAccountEntry(plaintext)).toBeNull();
  });
});

describe('syncAccounts', () => {
  const savedDefine = process.env.MIDEN_WALLET_API_URL;
  let removeImportShim: () => void;
  let server: FakeWalletApi;
  let restoreFetch: () => void;

  interface Device {
    vault: FakeVault;
    storage: MemoryStorage;
  }

  function device(...names: string[]): Device {
    return {
      vault: new FakeVault(
        PHRASE_A,
        names.map((name, index) => makeAccount(name, index))
      ),
      storage: new MemoryStorage()
    };
  }

  /** Move this realm to `target`, as the same phrase on another install. */
  async function use(target: Device): Promise<BackupSession> {
    clearBackupSession();
    onBackupStorageCleared();
    setActiveVault(target.vault);
    setActiveStorage(target.storage);
    const opened = await getBackupSession();
    if (!('session' in opened)) throw new Error(`No session: ${opened.unavailable}`);
    return opened.session;
  }

  function accountReads(mark: number): number {
    return server
      .requestsSince(mark)
      .filter(request => request.path === '/v1/storage/accounts' && request.method === 'GET').length;
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
    server = new FakeWalletApi();
    restoreFetch = installFakeFetch(server);
    jest.mocked(accountsUpdated).mockClear();
  });

  afterEach(() => {
    clearBackupSession();
    restoreFetch();
    jest.restoreAllMocks();
  });

  it('uploads one entry per HD account and leaves imported accounts out', async () => {
    const a = device('Main', 'Second');
    a.vault.accounts.push(makeAccount('Imported', -1, 'pk-imported'));
    const session = await use(a);

    await expect(syncAccounts(session, true)).resolves.toBe(false);
    const keys = server.entriesOf(session.publicKey, 'accounts').map(entry => entry.hashedKey);
    expect(keys.sort()).toEqual([hashedKeyOf(session, 'guardian:0'), hashedKeyOf(session, 'guardian:1')].sort());
    expect(session.merge.accountNames).toEqual({
      'guardian:0': { name: 'Main', nlu: 0 },
      'guardian:1': { name: 'Second', nlu: 0 }
    });
  });

  it("renames a local account to a peer's newer name", async () => {
    const a = device('Main');
    const b = device('Account 1');
    await syncAccounts(await use(a), true);
    await syncAccounts(await use(b), true);
    // A name this device never saw change has nlu 0, so the peer's copy wins over it.
    expect(b.vault.nameAt(0)).toBe('Main');

    const renamedAt = Date.now() + 1000;
    jest.spyOn(Date, 'now').mockReturnValue(renamedAt);
    a.vault.accounts[0] = { ...makeAccount('Savings', 0) };
    await syncAccounts(await use(a), true);

    const sessionB = await use(b);
    await expect(syncAccounts(sessionB, true)).resolves.toBe(true);
    expect(b.vault.nameAt(0)).toBe('Savings');
    expect(accountsUpdated).toHaveBeenCalled();
    expect(sessionB.merge.accountNames['guardian:0']).toEqual({ name: 'Savings', nlu: renamedAt });
    expect(JSON.parse(b.vault.mergeRecords ?? '{}').accountNames['guardian:0'].nlu).toBe(renamedAt);
  });

  it('keeps the latest rename when both devices renamed', async () => {
    const a = device('Main');
    const b = device('Main');
    const start = Date.now();
    const now = jest.spyOn(Date, 'now');
    await syncAccounts(await use(a), true);
    await syncAccounts(await use(b), true);

    now.mockReturnValue(start + 1000);
    a.vault.accounts[0] = makeAccount('Older', 0);
    await syncAccounts(await use(a), true);

    // B renamed later. Its sync reads A's rename first and keeps its own, then uploads it.
    now.mockReturnValue(start + 2000);
    b.vault.accounts[0] = makeAccount('Newer', 0);
    await expect(syncAccounts(await use(b), true)).resolves.toBe(true);
    expect(b.vault.nameAt(0)).toBe('Newer');

    await syncAccounts(await use(a), true);
    expect(a.vault.nameAt(0)).toBe('Newer');
  });

  it('does not apply a name the wallet would refuse, or one another local account holds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const a = device('Main', 'Second');
    const b = device('Main', 'Taken');
    const now = jest.spyOn(Date, 'now');
    await syncAccounts(await use(a), true);
    await syncAccounts(await use(b), true);

    now.mockReturnValue(Date.now() + 1000);
    // A gives account 0 a name the pattern refuses, and account 1 the name "Taken".
    a.vault.accounts = [makeAccount(' leading space', 0), makeAccount('Taken', 1)];
    await syncAccounts(await use(a), true);
    // Meanwhile B gave "Taken" to its account 0 (its first sync took "Second" for account 1 from A).
    b.vault.accounts = [makeAccount('Taken', 0), makeAccount('Second', 1)];
    await syncAccounts(await use(b), true);

    expect(b.vault.nameAt(0)).toBe('Taken');
    expect(b.vault.nameAt(1)).toBe('Second');
    expect(warn).toHaveBeenCalledWith('[backup] a synced account name was not applied', expect.any(Error));
  });

  it('ignores a tombstone and an account this device does not hold', async () => {
    const b = device('Main');
    const session = await use(b);
    await syncAccounts(session, true);
    const now = Date.now() + 5000;
    const tombstone: AccountEntry = { ...ENTRY, n: 'Hidden', nlu: now, dt: now };
    const unknown: AccountEntry = { ...ENTRY, i: 7, n: 'Peer only', nlu: now };
    server.insertEntry(
      session.publicKey,
      'accounts',
      hashedKeyOf(session, 'guardian:0'),
      await encryptEntry(session.encKey, JSON.stringify(tombstone), session.kdfParams)
    );
    server.insertEntry(
      session.publicKey,
      'accounts',
      hashedKeyOf(session, 'guardian:7'),
      await encryptEntry(session.encKey, JSON.stringify(unknown), session.kdfParams)
    );

    await expect(syncAccounts(session, true)).resolves.toBe(true);
    expect(b.vault.accounts.map(account => account.name)).toEqual(['Main']);
    expect(accountsUpdated).not.toHaveBeenCalled();
  });

  it('reads before its first write even when the caller asks for no read, and not after', async () => {
    const session = await use(device('Main'));
    let mark = server.requests.length;
    await syncAccounts(session, false);
    expect(accountReads(mark)).toBe(1);

    mark = server.requests.length;
    await syncAccounts(session, false);
    expect(accountReads(mark)).toBe(0);
  });

  it('renames nothing for a session that closed while it waited for the accounts queue', async () => {
    const a = device('Main');
    await syncAccounts(await use(a), true);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    a.vault.accounts[0] = makeAccount('Savings', 0);
    await syncAccounts(await use(a), true);

    const b = device('Account 1');
    const session = await use(b);
    let release: () => void = () => {};
    const blocker = getAccountsWriteQueue().add(() => new Promise<void>(resolve => (release = resolve)));
    const running = syncAccounts(session, true);
    // Wait until the rename task waits in the queue behind the blocker, then lock.
    while (getAccountsWriteQueue().size === 0) await new Promise(resolve => setTimeout(resolve, 5));
    clearBackupSession();
    release();
    await blocker;
    await expect(running).rejects.toBeInstanceOf(BackupSessionClosedError);
    expect(b.vault.nameAt(0)).toBe('Account 1');
  });
});
