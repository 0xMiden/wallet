/**
 * @jest-environment node
 */
import { plaintextDigest } from 'lib/backup/crypto';

import {
  type BackupHistoryRecord,
  type ContactTriple,
  type RawTransactionRow,
  contactNetworkCode,
  contactsPlaintextDigest,
  eachTransactionOnceProblems,
  maxRevision,
  parseBackupStateSnapshot,
  parseStoreContacts,
  sameTransaction,
  serverHoldsContacts,
  toHistoryRecord
} from './multi-device-backup';

const rawRow = (overrides: Partial<RawTransactionRow>): RawTransactionRow => ({
  id: 'row-1',
  type: 'send',
  status: 2,
  accountId: 'mtst1account',
  noteIds: [],
  transactionId: null,
  amount: '10000',
  faucetId: 'mtst1faucet',
  error: null,
  restoredFromBackup: false,
  recovered: false,
  ...overrides
});

const record = (overrides: Partial<RawTransactionRow>): BackupHistoryRecord => {
  const parsed = toHistoryRecord(rawRow(overrides));
  if (parsed === null) throw new Error('the fixture row has an unknown status');
  return parsed;
};

describe('parseBackupStateSnapshot', () => {
  it('reads the key, the salt, the entry marks and the dirty chunks', () => {
    const snapshot = parseBackupStateSnapshot({
      v: 1,
      publicKey: '02abc',
      salt: 'aa'.repeat(16),
      profileEtag: 'etag-1',
      features: {
        accounts: { etag: 'e-acc', cursor: null, entries: { k1: { revision: 3, updatedAt: 5, digest: 'd1' } } },
        contacts: { etag: null, cursor: null, entries: {} },
        history: { etag: 'e-his', cursor: 9, entries: { k2: { revision: 1, updatedAt: 9, digest: 'd2' } } }
      },
      history: { chunks: [], assigned: {}, dirty: [0, 2] }
    });
    expect(snapshot).toEqual({
      publicKey: '02abc',
      salt: 'aa'.repeat(16),
      profileEtag: 'etag-1',
      features: {
        accounts: { etag: 'e-acc', marks: [{ hashedKey: 'k1', revision: 3, digest: 'd1' }] },
        contacts: { etag: null, marks: [] },
        history: { etag: 'e-his', marks: [{ hashedKey: 'k2', revision: 1, digest: 'd2' }] }
      },
      dirtyHistoryChunks: [0, 2]
    });
  });

  it('gives null when no session stored a state', () => {
    expect(parseBackupStateSnapshot(undefined)).toBeNull();
    expect(parseBackupStateSnapshot({ v: 1 })).toBeNull();
  });

  it('skips a mark of another shape and keeps the others', () => {
    const snapshot = parseBackupStateSnapshot({
      publicKey: '02abc',
      features: { contacts: { entries: { bad: { revision: 'x' }, good: { revision: 2, digest: 'd' } } } }
    });
    expect(snapshot?.features.contacts.marks).toEqual([{ hashedKey: 'good', revision: 2, digest: 'd' }]);
    expect(snapshot?.salt).toBeNull();
  });
});

describe('maxRevision', () => {
  it('is 0 with no entry and the highest revision otherwise', () => {
    expect(maxRevision({ etag: null, marks: [] })).toBe(0);
    expect(
      maxRevision({
        etag: null,
        marks: [
          { hashedKey: 'a', revision: 2, digest: 'x' },
          { hashedKey: 'b', revision: 7, digest: 'y' }
        ]
      })
    ).toBe(7);
  });
});

describe('contacts digest', () => {
  it('matches the digest the product records for the same list', () => {
    const lists: ContactTriple[][] = [[], [['Ledger friend', '0x000000000000000000000000000000000000b4c1', 't']]];
    for (const triples of lists) {
      expect(contactsPlaintextDigest(triples)).toBe(plaintextDigest(JSON.stringify(triples)));
    }
  });

  it('tells when the server holds exactly a list', () => {
    const triples: ContactTriple[] = [['Ann', '0xab', 't']];
    const snapshot = parseBackupStateSnapshot({
      publicKey: '02abc',
      features: {
        contacts: { entries: { k: { revision: 1, digest: contactsPlaintextDigest(triples) } } }
      }
    });
    expect(serverHoldsContacts(snapshot, triples)).toBe(true);
    expect(serverHoldsContacts(snapshot, [['Anne', '0xab', 't']])).toBe(false);
    expect(serverHoldsContacts(null, triples)).toBe(false);
  });

  it('maps each E2E network to its contacts code', () => {
    expect(contactNetworkCode('testnet')).toBe('t');
    expect(contactNetworkCode('devnet')).toBe('d');
    expect(contactNetworkCode('mainnet')).toBe('m');
    expect(contactNetworkCode('localhost')).toBe('l');
    expect(() => contactNetworkCode('moon')).toThrow('moon');
  });
});

describe('parseStoreContacts', () => {
  it('keeps the address-book contacts and leaves out the wallet accounts', () => {
    expect(
      parseStoreContacts({
        contacts: [
          { name: 'Ann', address: '0xab', addedAt: 1 },
          { name: 'Me', address: 'mtst1me', accountInWallet: true },
          { name: 7, address: '0xcd' }
        ]
      })
    ).toEqual([{ name: 'Ann', address: '0xab' }]);
    expect(parseStoreContacts(null)).toEqual([]);
  });
});

describe('toHistoryRecord', () => {
  it('normalizes the note and transaction ids and names the status', () => {
    expect(
      toHistoryRecord(rawRow({ noteIds: ['0xAB', 'ab', ' 0xcd '], transactionId: '0xFF', status: 4 }))
    ).toMatchObject({ noteIds: ['ab', 'cd'], transactionId: 'ff', status: 'Unconfirmed' });
  });

  it('gives null for an unknown status', () => {
    expect(toHistoryRecord(rawRow({ status: 9 }))).toBeNull();
    expect(toHistoryRecord(rawRow({ status: null }))).toBeNull();
  });
});

describe('sameTransaction', () => {
  it('matches the same row id, a shared note or the same transaction id', () => {
    const base = record({ id: 'a', noteIds: ['n1'], transactionId: 't1' });
    expect(sameTransaction(base, record({ id: 'a' }))).toBe(true);
    expect(sameTransaction(base, record({ id: 'b', noteIds: ['0xN1'] }))).toBe(true);
    expect(sameTransaction(base, record({ id: 'c', transactionId: '0xT1' }))).toBe(true);
    expect(sameTransaction(base, record({ id: 'd', noteIds: ['n2'], transactionId: 't2' }))).toBe(false);
  });

  it('does not match two rows without a shared id', () => {
    const first = record({ id: 'a', type: 'replace-hot-key' });
    const second = record({ id: 'b', type: 'replace-hot-key' });
    expect(sameTransaction(first, second)).toBe(false);
  });
});

describe('eachTransactionOnceProblems', () => {
  const claim = record({ id: 'claim', type: 'consume', noteIds: ['f1'], amount: '500' });
  const send = record({ id: 'send', type: 'send', noteIds: ['s1'], transactionId: 'tx1' });
  const rotation = record({ id: 'rot', type: 'replace-hot-key', noteIds: [], transactionId: 'tx2', amount: null });

  const expected = [
    { label: "A's claim", reference: claim, fromPeer: true },
    { label: "A's send", reference: send, fromPeer: true },
    { label: "B's rotation", reference: rotation, fromPeer: false }
  ];

  it('passes when each transaction shows once, peers as backup receipts', () => {
    const rows = [
      record({ id: 'claim', type: 'consume', noteIds: ['f1'], amount: '500', restoredFromBackup: true }),
      record({ id: 'send', type: 'send', noteIds: ['s1'], transactionId: 'tx1', restoredFromBackup: true }),
      record({ id: 'rot', type: 'replace-hot-key', transactionId: 'tx2', amount: null })
    ];
    expect(eachTransactionOnceProblems(rows, expected)).toEqual([]);
  });

  it('names a Guardian row that duplicates a backup receipt', () => {
    const rows = [
      record({ id: 'claim', type: 'consume', noteIds: ['f1'], amount: '500', restoredFromBackup: true }),
      record({ id: 'g-claim', type: 'consume', noteIds: ['f1'], amount: '500', recovered: true }),
      record({ id: 'send', type: 'send', noteIds: ['s1'], transactionId: 'tx1', restoredFromBackup: true }),
      record({ id: 'rot', type: 'replace-hot-key', transactionId: 'tx2', amount: null })
    ];
    const problems = eachTransactionOnceProblems(rows, expected);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("A's claim: 2 rows");
  });

  it('names a note-less duplicate that matches no transaction', () => {
    const rows = [
      record({ id: 'claim', type: 'consume', noteIds: ['f1'], amount: '500', restoredFromBackup: true }),
      record({ id: 'send', type: 'send', noteIds: ['s1'], transactionId: 'tx1', restoredFromBackup: true }),
      record({ id: 'rot', type: 'replace-hot-key', transactionId: 'tx2', amount: null }),
      record({ id: 'g-rot', type: 'replace-hot-key', amount: null, recovered: true })
    ];
    const problems = eachTransactionOnceProblems(rows, expected);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^unexpected row \[replace-hot-key Completed g-rot guardian/);
  });

  it('names a lost receipt, a missing row and a wrong amount', () => {
    const rows = [
      record({ id: 'g-claim', type: 'consume', noteIds: ['f1'], amount: '400', recovered: true }),
      record({ id: 'rot', type: 'replace-hot-key', transactionId: 'tx2', amount: null })
    ];
    const problems = eachTransactionOnceProblems(rows, expected);
    expect(problems).toEqual([
      expect.stringContaining("A's claim: amount is 400, expected 500"),
      expect.stringContaining("A's claim: the row is not the backup receipt"),
      expect.stringContaining("A's send: 0 rows, expected exactly 1")
    ]);
  });

  it('requires a device to hold its own transaction as its own row', () => {
    const rows = [
      record({ id: 'claim', type: 'consume', noteIds: ['f1'], amount: '500', restoredFromBackup: true }),
      record({ id: 'send', type: 'send', noteIds: ['s1'], transactionId: 'tx1', restoredFromBackup: true }),
      record({ id: 'g-rot', type: 'replace-hot-key', transactionId: 'tx2', amount: null, recovered: true })
    ];
    expect(eachTransactionOnceProblems(rows, expected)).toEqual([
      expect.stringContaining("B's rotation: the row is not this device's own row")
    ]);
  });
});
