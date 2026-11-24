import { settingsUpdated } from 'lib/miden/back/store';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { WalletContact } from 'lib/shared/types';

import { DEFAULT_BLOB_CAP, decryptEntry, encryptEntry, plaintextDigest } from '../crypto';
import { hashedKeyOf } from '../entries';
import { type BackupSession, clearBackupSession, getBackupSession } from '../session';
import { onBackupStorageCleared } from '../state';
import {
  CONTACTS_ENTRY_KEY,
  type ContactTriple,
  mergeContacts,
  networkCodeOf,
  parseContacts,
  projectContacts,
  syncContacts
} from './contacts';
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
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn() }));

const ALICE: ContactTriple = ['Alice', 'mtst1alice', 't'];
const BOB: ContactTriple = ['Bob', 'mtst1bob', 't'];
const CAROL: ContactTriple = ['Carol', 'mtst1carol', 't'];
const MAIN_DAVE: ContactTriple = ['Dave', 'mm1dave', 'm'];
const EVE_ADDRESS = `0x${'e'.repeat(40)}`;
const EVE: ContactTriple = ['Eve', EVE_ADDRESS, 't', 'base-sepolia'];

function contact(name: string, address: string): WalletContact {
  return { name, address, addedAt: 1 };
}

describe('contact triples', () => {
  it('maps each network to one letter', () => {
    expect(networkCodeOf(MIDEN_NETWORK_NAME.MAINNET)).toBe('m');
    expect(networkCodeOf(MIDEN_NETWORK_NAME.TESTNET)).toBe('t');
    expect(networkCodeOf(MIDEN_NETWORK_NAME.DEVNET)).toBe('d');
    expect(networkCodeOf(MIDEN_NETWORK_NAME.LOCALNET)).toBe('l');
  });

  it('parses a list and drops triples of another shape', () => {
    expect(parseContacts(JSON.stringify([ALICE, ['x', 'y'], ['n', 'a', 'z'], [1, 'a', 't'], 'no', MAIN_DAVE]))).toEqual(
      [ALICE, MAIN_DAVE]
    );
    expect(parseContacts('{')).toBeNull();
    expect(parseContacts('{"a":1}')).toBeNull();
  });

  it('projects the local contacts and leaves the accounts of this wallet out', () => {
    const own: WalletContact = { name: 'Me', address: 'mtst1me', accountInWallet: true };
    expect(projectContacts([contact('Alice', 'mtst1alice'), own], 't')).toEqual([ALICE]);
  });

  // A `0x` address is valid on every EVM chain, so its contact keeps the destination network it is for.
  it('projects the network of a 0x contact, and keeps a contact without one a triple', () => {
    const evm: WalletContact = { ...contact('Eve', EVE_ADDRESS), network: 'base-sepolia' };
    const projected = projectContacts([contact('Alice', 'mtst1alice'), evm], 't');
    expect(projected).toEqual([ALICE, EVE]);
    expect(JSON.stringify(projected)).toBe(`[${JSON.stringify(ALICE)},${JSON.stringify(EVE)}]`);
  });

  it('parses the network of an entry, and an entry without one or with an unreadable one as a triple', () => {
    expect(parseContacts(JSON.stringify([ALICE, EVE]))).toEqual([ALICE, EVE]);
    expect(parseContacts(JSON.stringify([['Eve', EVE_ADDRESS, 't', 7]]))).toEqual([['Eve', EVE_ADDRESS, 't']]);
    expect(parseContacts(JSON.stringify([['Eve', EVE_ADDRESS, 't', '']]))).toEqual([['Eve', EVE_ADDRESS, 't']]);
    expect(parseContacts(JSON.stringify([['Eve', EVE_ADDRESS, 't', 'x'.repeat(65)]]))).toEqual([
      ['Eve', EVE_ADDRESS, 't']
    ]);
  });
});

describe('the network of a 0x contact in the merge', () => {
  it('keeps a local network change, and follows the server network otherwise', () => {
    const onSepolia: ContactTriple = ['Eve', EVE_ADDRESS, 't', 'sepolia'];
    // Here: Eve moved to base-sepolia. There: nothing changed.
    expect(mergeContacts([onSepolia], [EVE], [onSepolia], 't')).toEqual([EVE]);
    // There: Eve moved to base-sepolia. Here: nothing changed.
    expect(mergeContacts([onSepolia], [onSepolia], [EVE], 't')).toEqual([EVE]);
  });
});

describe('mergeContacts', () => {
  it('takes the union of both sides on the first sync, the local name first', () => {
    const local: ContactTriple[] = [ALICE, ['Robert', 'mtst1bob', 't']];
    expect(mergeContacts([], local, [BOB, CAROL], 't')).toEqual([['Robert', 'mtst1bob', 't'], CAROL, ALICE]);
  });

  it('keeps a local addition, removal and rename, and follows the server for the rest', () => {
    const base = [ALICE, BOB, CAROL];
    // Here: Alice removed, Bob renamed, Erin added. There: Carol renamed.
    const local: ContactTriple[] = [['Robert', 'mtst1bob', 't'], CAROL, ['Erin', 'mtst1erin', 't']];
    const server: ContactTriple[] = [ALICE, BOB, ['Caroline', 'mtst1carol', 't']];
    expect(mergeContacts(base, local, server, 't')).toEqual([
      ['Robert', 'mtst1bob', 't'],
      ['Caroline', 'mtst1carol', 't'],
      ['Erin', 'mtst1erin', 't']
    ]);
  });

  it('keeps a removal from the server when the local copy did not change', () => {
    expect(mergeContacts([ALICE, BOB], [ALICE, BOB], [ALICE], 't')).toEqual([ALICE]);
  });

  it('compares addresses trimmed and in lower case', () => {
    const local: ContactTriple[] = [['Alice', ' MTST1ALICE ', 't']];
    expect(mergeContacts([ALICE], local, [ALICE], 't')).toEqual([ALICE]);
  });

  it('keeps the triples of other networks from the server, after this network', () => {
    const localOther: ContactTriple = ['Local main', 'mm1local', 'm'];
    expect(mergeContacts([], [ALICE, localOther], [MAIN_DAVE, BOB], 't')).toEqual([BOB, ALICE, MAIN_DAVE]);
  });
});

describe('syncContacts', () => {
  const savedDefine = process.env.MIDEN_WALLET_API_URL;
  let removeImportShim: () => void;
  let server: FakeWalletApi;
  let restoreFetch: () => void;

  interface Device {
    vault: FakeVault;
    storage: MemoryStorage;
  }

  function device(...contacts: WalletContact[]): Device {
    return { vault: new FakeVault(PHRASE_A, [], contacts), storage: new MemoryStorage() };
  }

  async function use(target: Device): Promise<BackupSession> {
    clearBackupSession();
    onBackupStorageCleared();
    setActiveVault(target.vault);
    setActiveStorage(target.storage);
    const opened = await getBackupSession();
    if (!('session' in opened)) throw new Error(`No session: ${opened.unavailable}`);
    return opened.session;
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
    jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    jest.mocked(settingsUpdated).mockClear();
  });

  afterEach(() => {
    clearBackupSession();
    restoreFetch();
    jest.restoreAllMocks();
  });

  it("gives a new device the peer's contacts and records the server copy as the base", async () => {
    const a = device(contact('Alice', 'mtst1alice'), contact('Bob', 'mtst1bob'));
    const sessionA = await use(a);
    await expect(syncContacts(sessionA, true)).resolves.toBe(false);
    expect(sessionA.merge.contactsBase).toBe(JSON.stringify([ALICE, BOB]));

    const b = device();
    const sessionB = await use(b);
    await expect(syncContacts(sessionB, true)).resolves.toBe(true);
    expect(b.vault.contactPairs()).toEqual([
      ['Alice', 'mtst1alice'],
      ['Bob', 'mtst1bob']
    ]);
    expect(settingsUpdated).toHaveBeenCalled();
    expect(sessionB.merge.contactsBase).toBe(JSON.stringify([ALICE, BOB]));
    // B's list equals the server copy: nothing more to upload.
    expect(server.entriesOf(sessionB.publicKey, 'contacts')[0]?.revision).toBe(1);
  });

  it("keeps both sides' edits through the three-way merge", async () => {
    const a = device(contact('Alice', 'mtst1alice'), contact('Bob', 'mtst1bob'));
    const b = device();
    await syncContacts(await use(a), true);
    await syncContacts(await use(b), true);

    // A adds Carol and uploads it.
    a.vault.settings = { contacts: [...(a.vault.settings.contacts ?? []), contact('Carol', 'mtst1carol')] };
    await syncContacts(await use(a), true);

    // B, which has not read since, removes Alice and renames Bob.
    b.vault.settings = { contacts: [{ ...contact('Robert', 'mtst1bob'), addedAt: 42 }] };
    await expect(syncContacts(await use(b), true)).resolves.toBe(true);
    expect(b.vault.contactPairs()).toEqual([
      ['Robert', 'mtst1bob'],
      ['Carol', 'mtst1carol']
    ]);
    // The local fields a triple does not carry stay.
    expect(b.vault.settings.contacts?.[0]?.addedAt).toBe(42);

    await syncContacts(await use(a), true);
    expect(a.vault.contactPairs()).toEqual([
      ['Robert', 'mtst1bob'],
      ['Carol', 'mtst1carol']
    ]);
  });

  // The merge reads the settings, then writes the whole list: a user write between the two must survive.
  it('keeps a contact the user saved while the merge ran', async () => {
    const a = device(contact('Alice', 'mtst1alice'));
    await syncContacts(await use(a), true);
    await syncContacts(await use(device(contact('Alice', 'mtst1alice'), contact('Bob', 'mtst1bob'))), true);

    const session = await use(a);
    const read = a.vault.fetchSettings.bind(a.vault);
    jest.spyOn(a.vault, 'fetchSettings').mockImplementationOnce(async () => {
      const snapshot = await read();
      a.vault.settings = { contacts: [...(a.vault.settings.contacts ?? []), contact('Carol', 'mtst1carol')] };
      return snapshot;
    });
    await syncContacts(session, true);

    expect(a.vault.contactPairs()).toEqual(
      expect.arrayContaining([
        ['Alice', 'mtst1alice'],
        ['Bob', 'mtst1bob'],
        ['Carol', 'mtst1carol']
      ])
    );
    const uploaded = server.storedEntryOf(session.publicKey, 'contacts', hashedKeyOf(session, CONTACTS_ENTRY_KEY));
    if (uploaded === undefined) throw new Error('No contacts entry on the server');
    expect(await decryptEntry(session.encKey, uploaded, DEFAULT_BLOB_CAP)).toContain('mtst1carol');
  });

  it('writes and uploads nothing while the local list keeps changing', async () => {
    const a = device(contact('Alice', 'mtst1alice'));
    await syncContacts(await use(a), true);
    await syncContacts(await use(device(contact('Alice', 'mtst1alice'), contact('Bob', 'mtst1bob'))), true);

    const session = await use(a);
    const read = a.vault.fetchSettings.bind(a.vault);
    let edits = 0;
    jest.spyOn(a.vault, 'fetchSettings').mockImplementation(async () => {
      const snapshot = await read();
      edits += 1;
      a.vault.settings = {
        contacts: [...(a.vault.settings.contacts ?? []), contact(`User ${edits}`, `mtst1user${edits}`)]
      };
      return snapshot;
    });
    const write = jest.spyOn(a.vault, 'updateSettings');
    const mark = server.requests.length;
    await expect(syncContacts(session, true)).rejects.toThrow('kept changing');
    expect(write).not.toHaveBeenCalled();
    expect(server.requestsSince(mark).some(request => request.method === 'PUT')).toBe(false);
  });

  it('merges local edits against the base and uploads them without a read', async () => {
    const a = device(contact('Alice', 'mtst1alice'));
    const session = await use(a);
    await syncContacts(session, true);
    a.vault.settings = { contacts: [contact('Alice', 'mtst1alice'), contact('Bob', 'mtst1bob')] };
    const mark = server.requests.length;

    await expect(syncContacts(session, false)).resolves.toBe(false);
    const requests = server.requestsSince(mark).map(request => `${request.method} ${request.path}`);
    expect(requests).toEqual(['PUT /v1/storage/contacts']);
    const plaintext = JSON.stringify([ALICE, BOB]);
    expect(session.merge.contactsBase).toBe(plaintext);
    expect(session.state.features.contacts.entries[hashedKeyOf(session, CONTACTS_ENTRY_KEY)]?.digest).toBe(
      plaintextDigest(plaintext)
    );
  });

  /** A peer writes this list as the contacts entry, under the session's key. */
  async function peerWrites(session: BackupSession, list: ContactTriple[]): Promise<void> {
    const entry = await encryptEntry(session.encKey, JSON.stringify(list), session.kdfParams);
    server.insertEntry(session.publicKey, 'contacts', hashedKeyOf(session, CONTACTS_ENTRY_KEY), entry);
  }

  async function serverList(session: BackupSession): Promise<string> {
    const stored = server.storedEntryOf(session.publicKey, 'contacts', hashedKeyOf(session, CONTACTS_ENTRY_KEY));
    if (stored === undefined) throw new Error('No contacts entry on the server');
    return decryptEntry(session.encKey, stored, DEFAULT_BLOB_CAP);
  }

  // Two refreshes overlap (unlock and the address book): the second must merge against the base the first left.
  it('does not bring back a contact a peer deleted between two overlapping syncs', async () => {
    const a = device(contact('Alice', 'mtst1alice'));
    const session = await use(a);
    await syncContacts(session, true);
    await peerWrites(session, [ALICE, BOB]);
    const deletion = await encryptEntry(session.encKey, JSON.stringify([ALICE]), session.kdfParams);
    let reads = 0;
    server.onRequest = request => {
      if (request.method !== 'GET' || request.path !== '/v1/storage/contacts') return;
      reads += 1;
      // The peer deletes Bob after the first sync adopted him, before the second sync reads.
      if (reads === 2) {
        server.insertEntry(session.publicKey, 'contacts', hashedKeyOf(session, CONTACTS_ENTRY_KEY), deletion);
      }
    };
    await Promise.all([syncContacts(session, true), syncContacts(session, true)]);
    server.onRequest = null;

    expect(a.vault.contactPairs()).toEqual([['Alice', 'mtst1alice']]);
    expect(await serverList(session)).not.toContain('mtst1bob');
  });

  it("keeps a peer's other-network contact when the second of two overlapping syncs reads a 304", async () => {
    const a = device(contact('Alice', 'mtst1alice'));
    const session = await use(a);
    await syncContacts(session, true);
    await peerWrites(session, [ALICE, MAIN_DAVE]);
    await Promise.all([syncContacts(session, true), syncContacts(session, true)]);

    expect(await serverList(session)).toContain('mm1dave');
    expect(session.merge.contactsBase).toBe(JSON.stringify([ALICE, MAIN_DAVE]));
  });

  it('gives a peer a 0x contact with its network, and uploads no change for contacts without one', async () => {
    const evm: WalletContact = { ...contact('Eve', EVE_ADDRESS), network: 'base-sepolia' };
    const a = device(contact('Alice', 'mtst1alice'), evm);
    await syncContacts(await use(a), true);

    const b = device();
    const sessionB = await use(b);
    await syncContacts(sessionB, true);
    expect(b.vault.settings.contacts?.find(saved => saved.address === EVE_ADDRESS)?.network).toBe('base-sepolia');
    expect(b.vault.settings.contacts?.find(saved => saved.address === 'mtst1alice')?.network).toBeUndefined();
    expect(server.entriesOf(sessionB.publicKey, 'contacts')[0]?.revision).toBe(1);
  });

  it('applies a network change made on a peer', async () => {
    const onSepolia: WalletContact = { ...contact('Eve', EVE_ADDRESS), network: 'sepolia' };
    const a = device(onSepolia);
    const b = device({ ...onSepolia });
    await syncContacts(await use(a), true);
    await syncContacts(await use(b), true);

    a.vault.settings = { contacts: [{ ...onSepolia, network: 'base-sepolia' }] };
    await syncContacts(await use(a), true);
    await expect(syncContacts(await use(b), true)).resolves.toBe(true);
    expect(b.vault.settings.contacts?.[0]?.network).toBe('base-sepolia');
  });

  // A build without the field writes triples: the local network stays, and the next upload carries it again.
  it('keeps the local network when a peer entry carries none', async () => {
    const evm: WalletContact = { ...contact('Eve', EVE_ADDRESS), network: 'base-sepolia' };
    const a = device(evm);
    const session = await use(a);
    await syncContacts(session, true);
    await peerWrites(session, [['Eve', EVE_ADDRESS, 't'], BOB]);

    await syncContacts(session, true);
    expect(a.vault.settings.contacts?.find(saved => saved.address === EVE_ADDRESS)?.network).toBe('base-sepolia');
    expect(a.vault.contactPairs()).toEqual([
      ['Eve', EVE_ADDRESS],
      ['Bob', 'mtst1bob']
    ]);
  });

  it('keeps the contacts of other networks that a peer stored', async () => {
    const a = device(contact('Dave', 'mm1dave'));
    jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
    await syncContacts(await use(a), true);

    jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    const b = device(contact('Alice', 'mtst1alice'));
    const sessionB = await use(b);
    await syncContacts(sessionB, true);
    expect(b.vault.contactPairs()).toEqual([['Alice', 'mtst1alice']]);
    expect(sessionB.merge.contactsBase).toBe(JSON.stringify([ALICE, MAIN_DAVE]));
  });
});
