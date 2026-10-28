import type { NoteFile } from '@miden-sdk/miden-sdk/lazy';
import Dexie from 'dexie';

import { restoreSdkRecovery, decodeSdkRecoveryCommand, type RecoverySdkWriter } from './sdk-restore';
import type { RecoveryNoteEntry } from './types';

const mockConsumedNoteFiles = new WeakSet<object>();

function mockNoteFile(bytes: Uint8Array) {
  const expected = bytes[0] === 2 || bytes[0] === 4;
  const details = { commitment: 'details-a' };
  const file = {
    noteDetails: () => (expected ? details : undefined),
    note: () => (expected ? undefined : details),
    noteId: () => (expected ? undefined : { toString: () => 'note-a', free: () => {} }),
    inclusionProof: () =>
      expected ? undefined : { location: () => ({ blockNum: () => 5, free: () => {} }), free: () => {} },
    noteType: () => (expected ? 'NoteDetails' : 'NoteWithProof'),
    noteTag: () => (expected ? { asU32: () => (bytes[0] === 2 ? 71 : 0), free: () => {} } : undefined),
    afterBlockNum: () => (expected ? (bytes[0] === 2 ? 19 : 0) : undefined),
    serialize: () => bytes.slice(),
    free: jest.fn(() => {
      if (mockConsumedNoteFiles.has(file)) throw new Error('SDK note file handle was consumed');
    })
  };
  return file;
}

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  InputNoteState: { Expected: 0, Unverified: 1, Committed: 2, Invalid: 3, ConsumedAuthenticatedLocal: 6 },
  NoteType: { Private: 0, Public: 1 },
  NoteFile: {
    deserialize: mockNoteFile,
    fromInputNote: () => mockNoteFile(new Uint8Array([1])),
    fromNoteDetails: () => mockNoteFile(new Uint8Array([4]))
  }
}));
jest.mock('../sdk/note-details-commitment', () => ({
  noteDetailsCommitment: (value: object) => Reflect.get(value, 'commitment')
}));

const note: RecoveryNoteEntry = {
  kind: 'note',
  id: 'note-a',
  provenance: 'input',
  noteFile: new Uint8Array([1]),
  format: 'full'
};
let marker: string | null;
let db: Dexie;
let databaseSequence = 0;
let importedState: number | undefined;
function record(state = 2, commitment = 'details-a') {
  return {
    details: () => ({ commitment, free: () => {} }),
    state: () => state,
    isAuthenticated: () => state === 2 || state === 6,
    isInclusionPending: () => state === 0 || state === 1,
    isConsumed: () => state === 6,
    id: () => (state === 0 ? undefined : { toString: () => 'note-a', free: () => {} }),
    metadata: () => (state === 0 ? undefined : { noteType: () => 0, free: () => {} }),
    toInputNote: () => {
      if (state === 0) throw new Error('Expected record has no metadata');
      return {};
    },
    free: () => {}
  };
}
let records: ReturnType<typeof record>[];
let afterImport: () => void;
const client: RecoverySdkWriter = {
  settings: {
    get: jest
      .fn()
      .mockImplementation(async () => (marker === null ? null : Array.from(new TextEncoder().encode(marker)))),
    set: jest.fn().mockImplementation(async (_key: string, value: number[]) => {
      marker = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(value));
    })
  },
  accounts: {
    get: jest.fn().mockResolvedValue({
      nonce: () => ({ asInt: () => 1n }),
      to_commitment: () => ({ toHex: () => 'state', free: () => {} })
    }),
    insert: jest.fn()
  },
  notes: {
    listPage: jest.fn().mockImplementation(async () => ({
      notes: records.filter(item => [0, 1, 2, 4, 5].includes(item.state())),
      nextCursor: records.length > 0 ? '0x' + '11'.repeat(32) : null,
      exhausted: true
    })),
    list: jest.fn().mockImplementation(async (query?: { ids?: string[]; status?: string }) => {
      if (query?.ids) return records.filter(item => query.ids?.includes(item.id()?.toString() ?? ''));
      if (query?.status) {
        const states: Record<string, number> = { expected: 0, unverified: 1, committed: 2, processing: 4 };
        return records.filter(item => item.state() === states[query.status!]);
      }
      return records;
    }),
    import: jest.fn().mockImplementation(async (file: ReturnType<typeof mockNoteFile>) => {
      const state = importedState ?? (file.noteType() === 'NoteDetails' ? 0 : 2);
      records = [record(state)];
      await db.table('inputNotes').put({ detailsCommitment: 'details-a', stateDiscriminant: state });
      afterImport();
      return file.noteId()?.toString() ?? 'details-a';
    })
  },
  storeIdentifier: jest.fn().mockImplementation(async () => db.name)
};

beforeEach(async () => {
  jest.clearAllMocks();
  marker = null;
  records = [];
  importedState = undefined;
  afterImport = () => {};
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: (_name: string, operation: () => Promise<unknown>) => operation() }
  });
  db = new Dexie(`recovery-restore-${databaseSequence++}`);
  db.version(1).stores({ inputNotes: 'detailsCommitment,stateDiscriminant' });
  await db.open();
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

it('imports a retained input file and verifies its body before acknowledging the recovery step', async () => {
  await expect(
    restoreSdkRecovery(client, { kind: 'note', note, accountId: 'retained' }, () => {})
  ).resolves.toBeUndefined();
  expect(records).toHaveLength(1);
  expect(client.notes.import).toHaveBeenCalledTimes(1);
});

it('advances chain state before importing a retained full-proof input', async () => {
  const advance = jest.fn().mockResolvedValue(undefined);
  await expect(
    Reflect.apply(restoreSdkRecovery, undefined, [
      client,
      { kind: 'note', note, accountId: 'retained' },
      () => {},
      undefined,
      advance
    ])
  ).resolves.toBeUndefined();
  expect(advance).toHaveBeenCalledWith(5);
  expect(advance.mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(client.notes.import).mock.invocationCallOrder[0]!);
});

it('refuses the retained import when recovery chain advancement fails', async () => {
  const advance = jest.fn().mockRejectedValue(new Error('chain advancement refused'));
  await expect(
    Reflect.apply(restoreSdkRecovery, undefined, [
      client,
      { kind: 'note', note, accountId: 'retained' },
      () => {},
      undefined,
      advance
    ])
  ).rejects.toThrow('chain advancement refused');
  expect(client.notes.import).not.toHaveBeenCalled();
});

it.each(['accepted', 'rejected'])(
  'Task4C3O preserves the %s import outcome after SDK consumes the note file handle',
  async outcome => {
    const refusal = new Error('SDK import refused the retained note');
    let transferred: NoteFile | undefined;
    let inspected: NoteFile | undefined;
    jest.mocked(client.notes.import).mockImplementationOnce(async file => {
      transferred = file;
      mockConsumedNoteFiles.add(file);
      if (outcome === 'rejected') throw refusal;
      records = [record(2)];
      await db.table('inputNotes').put({ detailsCommitment: 'details-a', stateDiscriminant: 2 });
      return 'note-a';
    });
    const result = await restoreSdkRecovery(
      client,
      { kind: 'note', note, accountId: 'retained' },
      () => {},
      async (file, importNote) => {
        inspected = file;
        return importNote();
      }
    ).then(
      () => 'restored',
      (error: unknown) => error
    );
    expect(result).toBe(outcome === 'accepted' ? 'restored' : refusal);
    expect(transferred).not.toBe(inspected);
    expect(inspected?.free).toHaveBeenCalledTimes(1);
    expect(transferred?.free).not.toHaveBeenCalled();
    expect(client.notes.import).toHaveBeenCalledTimes(1);
    expect(records.map(item => item.isAuthenticated())).toEqual(outcome === 'accepted' ? [true] : []);
    expect(client.settings.set).not.toHaveBeenCalled();
  }
);

it.each(['acquire refusal', 'async facade refusal'])(
  'Task4C3O preserves %s and releases the untransferred inspection handle',
  async scenario => {
    const refusal = new Error('Before native ownership transfer');
    let inspected: NoteFile | undefined;
    if (scenario === 'async facade refusal')
      jest.mocked(client.notes.import).mockImplementationOnce(async () => {
        throw refusal;
      });
    const result = await restoreSdkRecovery(
      client,
      { kind: 'note', note, accountId: 'retained' },
      () => {},
      async (file, importNote) => {
        inspected = file;
        if (scenario === 'acquire refusal') throw refusal;
        return importNote();
      }
    ).then(
      () => 'restored',
      (error: unknown) => error
    );
    expect(result).toBe(refusal);
    expect(inspected?.free).toHaveBeenCalledTimes(1);
    expect(client.notes.import).toHaveBeenCalledTimes(scenario === 'acquire refusal' ? 0 : 1);
    expect(records).toEqual([]);
    expect(client.settings.set).not.toHaveBeenCalled();
  }
);

it('preserves a matching already consumed record without importing it again', async () => {
  records = [record(6)];
  await expect(
    restoreSdkRecovery(client, { kind: 'note', note, accountId: 'retained' }, () => {})
  ).resolves.toBeUndefined();
  expect(client.notes.import).not.toHaveBeenCalled();
});

it('refuses a same-id note whose retained body differs', async () => {
  records = [record(2, 'different')];
  await expect(restoreSdkRecovery(client, { kind: 'note', note, accountId: 'retained' }, () => {})).rejects.toThrow();
  expect(client.notes.import).not.toHaveBeenCalled();
});

it('does not acknowledge a note after the active holder is abandoned during import', async () => {
  let current = true;
  afterImport = () => {
    current = false;
  };
  await expect(
    restoreSdkRecovery(client, { kind: 'note', note, accountId: 'retained' }, () => {
      if (!current) throw new Error('abandoned');
    })
  ).rejects.toThrow('abandoned');
});

it('adopts only the retained logical SDK generation and verifies it', async () => {
  await expect(
    restoreSdkRecovery(client, { kind: 'generation', generation: 'retained-generation' }, () => {})
  ).resolves.toBeUndefined();
  expect(marker).toBe('retained-generation');
});

it('preserves a different surviving SDK generation', async () => {
  marker = 'other-wallet';
  await expect(
    restoreSdkRecovery(client, { kind: 'generation', generation: 'retained-generation' }, () => {})
  ).rejects.toThrow();
  expect(marker).toBe('other-wallet');
  expect(client.settings.set).not.toHaveBeenCalled();
});

it('rejects an unbounded recovery command before SDK materialization', () => {
  expect(() => decodeSdkRecoveryCommand({ kind: 'generation', generation: 'x'.repeat(129) })).toThrow();
  expect(() => decodeSdkRecoveryCommand({ kind: 'account', material: { accountBytes: [] } })).toThrow();
});

const quarantined = {
  ...note,
  candidates: [{ id: 'note-a', noteFile: new Uint8Array([3]), provenance: 'input', format: 'full' }]
} satisfies RecoveryNoteEntry;

it.each([
  ['Unverified', 1],
  ['Invalid', 3]
])('Task4C3D SDK Ok with an %s full-proof primary does not satisfy recovery', async (_state, state) => {
  if (typeof state !== 'number') throw new Error('Invalid fixture state');
  importedState = state;
  await expect(
    restoreSdkRecovery(client, { kind: 'note', note: quarantined, accountId: 'retained' }, () => {})
  ).rejects.toMatchObject({ name: 'StorageContinuityError' });
});

it('Task4C3D a quarantined candidate cannot veto or overwrite an authenticated primary', async () => {
  records = [record(2)];
  await expect(
    restoreSdkRecovery(client, { kind: 'note', note: quarantined, accountId: 'retained' }, () => {})
  ).resolves.toBeUndefined();
  expect(client.notes.import).not.toHaveBeenCalled();
  expect(records[0]?.isAuthenticated()).toBe(true);
});

it('Task4C3D a body-only Expected primary remains unresolved despite a full hint and quarantined proof', async () => {
  const expected: RecoveryNoteEntry = { ...quarantined, id: 'details-a', noteFile: new Uint8Array([2]) };
  await expect(
    restoreSdkRecovery(client, { kind: 'note', note: expected, accountId: 'retained' }, () => {})
  ).resolves.toBeUndefined();
  expect(client.notes.import).toHaveBeenCalledTimes(1);
  expect(records[0]?.state()).toBe(0);
  expect(records[0]?.isAuthenticated()).toBe(false);
});
