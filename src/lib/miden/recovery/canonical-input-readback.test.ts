import { readSdkRecoverySnapshot, type RecoverySdkReader } from './sdk-snapshot';
import type { RecoveryNoteEntry } from './types';
import { getStorageHealth } from '../storage-health';

const detailsId = '1'.padStart(64, '0');
const noteId = '11'.repeat(32);
const nullifier = '22'.repeat(32);
const expectedBytes = new Uint8Array([19, 48, 70]);
const canonicalBytes = new Uint8Array([19, 48, 71]);
let mockState = 2;
let mockExportDetails = 1;
let mockExportId = noteId;
let mockExportNullifier = nullifier;

function mockDetails(seed = 1) {
  return {
    recipient: () => ({ digest: () => ({ toFelts: () => [seed, 0, 0, 0] }) }),
    assets: () => ({ assets: () => [] }),
    free: () => undefined
  };
}
function mockIdentifier(id: string) {
  return { toString: () => id, free: () => undefined };
}
function mockProof() {
  return { location: () => ({ blockNum: () => 19, free: () => undefined }), free: () => undefined };
}
function mockFile(bytes: Uint8Array) {
  const expected = bytes[2] === 70;
  const exported = bytes[2] === 71;
  const id = bytes[2] === 73 ? '33'.repeat(32) : exported ? mockExportId : noteId;
  const details = mockDetails(exported ? mockExportDetails : 1);
  return {
    note: () =>
      expected
        ? undefined
        : { ...details, id: () => mockIdentifier(id), metadata: () => ({ noteType: () => 0, free: () => undefined }) },
    noteDetails: () => (expected ? details : undefined),
    noteId: () => (expected ? undefined : mockIdentifier(id)),
    nullifier: () => (expected ? undefined : exported ? mockExportNullifier : nullifier),
    inclusionProof: () => (expected ? undefined : mockProof()),
    noteTag: () => (expected ? { asU32: () => 71, free: () => undefined } : undefined),
    afterBlockNum: () => (expected ? 7 : undefined),
    serialize: () => bytes.slice(),
    free: () => undefined
  };
}
const mockToInputNote = jest.fn(() => ({ free: () => undefined }));
const mockExportInput = jest.fn((_input: unknown) => mockFile(canonicalBytes));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  InputNoteState: {
    Expected: 0,
    Unverified: 1,
    Committed: 2,
    Invalid: 3,
    ProcessingAuthenticated: 4,
    ConsumedAuthenticatedLocal: 6,
    ConsumedExternal: 8
  },
  NoteType: { Private: 0, Public: 1 },
  FeltArray: class {
    constructor(readonly elements: number[]) {}
  },
  Poseidon2: {
    hashElements: (values: { elements: number[] }) => {
      const value = values.elements.reduce((total, item) => total + item, 0);
      return { toHex: () => value.toString(16).padStart(64, '0'), toFelts: () => [value, 0, 0, 0] };
    }
  },
  NoteFile: { deserialize: mockFile, fromInputNote: (input: unknown) => mockExportInput(input) }
}));

function inputRecord() {
  return {
    details: () => mockDetails(),
    id: () => (mockState === 0 ? undefined : mockIdentifier(noteId)),
    state: () => mockState,
    isAuthenticated: () => mockState === 2 || mockState === 4 || mockState === 6,
    isConsumed: () => mockState === 6 || mockState === 8,
    isInclusionPending: () => mockState === 0 || mockState === 1,
    nullifier: () => (mockState === 0 ? undefined : nullifier),
    inclusionProof: () => (mockState === 0 ? undefined : mockProof()),
    metadata: () => (mockState === 0 ? undefined : { noteType: () => 0, free: () => undefined }),
    toInputNote: mockToInputNote,
    free: () => undefined
  };
}
function reader() {
  const list = jest.fn().mockResolvedValue([inputRecord()]);
  const notes = { list, import: jest.fn(), export: jest.fn(), listPage: jest.fn() };
  const client: RecoverySdkReader = {
    settings: {
      get: jest.fn().mockResolvedValue(Array.from(new TextEncoder().encode('sdk-generation'))),
      set: jest.fn()
    },
    accounts: {
      get: jest.fn().mockResolvedValue({
        nonce: () => ({ asInt: () => 4n }),
        to_commitment: () => ({ toHex: () => 'state-4', free: () => undefined })
      })
    },
    notes,
    storeIdentifier: jest.fn().mockResolvedValue('unused-baseline-database')
  };
  return { client, notes };
}
function family(): RecoveryNoteEntry {
  return {
    kind: 'note',
    id: detailsId,
    detailsId,
    noteFile: expectedBytes.slice(),
    provenance: 'input',
    format: 'details',
    candidates: [{ id: noteId, detailsId, noteFile: new Uint8Array([19, 48, 72]), provenance: 'input', format: 'full' }]
  };
}
async function readCanonical(client: RecoverySdkReader, retained = family()) {
  const snapshot: unknown = await Reflect.apply(readSdkRecoverySnapshot, undefined, [
    client,
    ['retained'],
    false,
    () => undefined,
    [],
    [retained]
  ]);
  if (typeof snapshot !== 'object' || snapshot === null) throw new Error('Missing SDK snapshot');
  return Reflect.get(snapshot, 'canonicalNotes') ?? [];
}

beforeEach(() => {
  mockState = 2;
  mockExportDetails = 1;
  mockExportId = noteId;
  mockExportNullifier = nullifier;
  mockToInputNote.mockClear();
  mockExportInput.mockClear();
});

describe('Task4C3G authenticated input readback', () => {
  it.each([2, 6])('resolves Expected primary from authenticated state %s with the exact input export', async state => {
    mockState = state;
    const { client, notes } = reader();
    const retained = family();
    const before = JSON.stringify(retained);
    expect(await readCanonical(client, retained)).toEqual([
      { familyId: detailsId, id: noteId, detailsId, noteFile: canonicalBytes }
    ]);
    expect(notes.list).toHaveBeenCalledWith({ detailsCommitments: [`0x${detailsId}`] });
    expect(notes.list).toHaveBeenCalledTimes(1);
    expect(mockToInputNote).toHaveBeenCalledTimes(1);
    expect(mockExportInput).toHaveBeenCalledTimes(1);
    expect(notes.import).not.toHaveBeenCalled();
    expect(notes.export).not.toHaveBeenCalled();
    expect(notes.listPage).not.toHaveBeenCalled();
    expect(client.storeIdentifier).not.toHaveBeenCalled();
    expect(JSON.stringify(retained)).toBe(before);
  });

  it.each([0, 1, 3, 8])('keeps unauthenticated state %s unresolved and healthy', async state => {
    mockState = state;
    const { client, notes } = reader();
    expect(await readCanonical(client)).toEqual([]);
    expect(mockToInputNote).not.toHaveBeenCalled();
    expect(mockExportInput).not.toHaveBeenCalled();
    expect(notes.import).not.toHaveBeenCalled();
    expect(getStorageHealth().status).toBe('healthy');
  });

  it.each(['details', 'id', 'nullifier'])(
    'refuses a mismatched exported %s without changing health',
    async mismatch => {
      if (mismatch === 'details') mockExportDetails = 2;
      if (mismatch === 'id') mockExportId = '44'.repeat(32);
      if (mismatch === 'nullifier') mockExportNullifier = '55'.repeat(32);
      const { client, notes } = reader();
      expect(await readCanonical(client)).toEqual([]);
      expect(notes.import).not.toHaveBeenCalled();
      expect(getStorageHealth().status).toBe('healthy');
    }
  );

  it.each(['duplicate', 'unrequested'])('refuses %s canonical query records without exporting', async result => {
    const { client, notes } = reader();
    notes.list.mockResolvedValueOnce(
      result === 'duplicate' ? [inputRecord(), inputRecord()] : [{ ...inputRecord(), details: () => mockDetails(2) }]
    );
    expect(await readCanonical(client)).toEqual([]);
    expect(mockExportInput).not.toHaveBeenCalled();
    expect(getStorageHealth().status).toBe('healthy');
  });

  it('propagates an actual SDK query quota failure to the owning storage classifier', async () => {
    const { client, notes } = reader();
    const failure = new DOMException('SDK query quota', 'QuotaExceededError');
    notes.list.mockRejectedValueOnce(failure);
    await expect(readCanonical(client)).rejects.toBe(failure);
    expect(mockExportInput).not.toHaveBeenCalled();
  });

  it('does not let a conflicting staged candidate veto an authenticated original primary', async () => {
    const { client } = reader();
    const retained = family();
    retained.candidates?.push({
      id: '33'.repeat(32),
      detailsId,
      noteFile: new Uint8Array([19, 48, 73]),
      provenance: 'input',
      format: 'full'
    });
    const before = JSON.stringify(retained);
    expect(await readCanonical(client, retained)).toEqual([
      { familyId: detailsId, id: noteId, detailsId, noteFile: canonicalBytes }
    ]);
    expect(JSON.stringify(retained)).toBe(before);
    expect(getStorageHealth().status).toBe('healthy');
  });
});

describe('Task4C3G2 canonical request limits', () => {
  it.each(['families', 'materials', 'bytes'])('refuses excess %s before SDK lookup or export', async limit => {
    const { client, notes } = reader();
    const retained = family();
    const families =
      limit === 'families'
        ? Array.from({ length: 5 }, (_, index) => ({ ...family(), id: String(index).padStart(64, '0') }))
        : [retained];
    if (limit === 'materials') {
      retained.candidates = Array.from({ length: 256 }, () => ({
        id: noteId,
        detailsId,
        noteFile: canonicalBytes.slice(),
        provenance: 'input',
        format: 'full'
      }));
    }
    if (limit === 'bytes') retained.noteFile = new Uint8Array(2 * 1024 * 1024);
    const before = families.map(entry => ({
      ...entry,
      noteFile: entry.noteFile.slice(),
      candidates: entry.candidates?.map(candidate => ({ ...candidate, noteFile: candidate.noteFile.slice() }))
    }));
    await expect(
      Reflect.apply(readSdkRecoverySnapshot, undefined, [client, ['retained'], false, () => undefined, [], families])
    ).rejects.toThrow('Recovery canonical note request exceeds limits');
    expect(notes.list).not.toHaveBeenCalled();
    expect(mockToInputNote).not.toHaveBeenCalled();
    expect(mockExportInput).not.toHaveBeenCalled();
    expect(notes.import).not.toHaveBeenCalled();
    expect(notes.export).not.toHaveBeenCalled();
    expect(notes.listPage).not.toHaveBeenCalled();
    expect(client.storeIdentifier).not.toHaveBeenCalled();
    expect(families).toEqual(before);
    expect(getStorageHealth().status).toBe('healthy');
  });
});

it('Task4C3G4 encodes the exact details query for the native Word parser', async () => {
  const { client, notes } = reader();
  notes.list.mockImplementation(async (query: { detailsCommitments: string[] }) => {
    if (query.detailsCommitments.some(value => !/^0x[a-f0-9]{64}$/.test(value)))
      throw new Error('InvalidLength: Word hex requires 66 characters including 0x');
    return [inputRecord()];
  });
  const outcome = await readCanonical(client).then(
    value => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  );
  expect(outcome).toEqual({
    value: [{ familyId: detailsId, id: noteId, detailsId, noteFile: canonicalBytes }],
    error: undefined
  });
  expect(notes.list).toHaveBeenCalledWith({ detailsCommitments: [`0x${detailsId}`] });
  expect(notes.import).not.toHaveBeenCalled();
  expect(getStorageHealth().status).toBe('healthy');
});
