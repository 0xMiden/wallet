import Dexie from 'dexie';

import {
  countRetainedInputNotes,
  readSdkRecoverySnapshot,
  initializeSdkGeneration,
  type RecoverySdkReader
} from './sdk-snapshot';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteType: { Private: 0, Public: 1 },
  NoteFile: {
    deserialize: () => ({
      noteDetails: () => ({}),
      noteId: () => ({ toString: () => 'missing-input' }),
      free: () => {}
    }),
    fromInputNote: () => ({ serialize: () => new Uint8Array([1, 2]), free: () => {} }),
    fromNoteDetails: () => ({ serialize: () => new Uint8Array([3, 4]), free: () => {} })
  }
}));
jest.mock('../sdk/note-details-commitment', () => ({ noteDetailsCommitment: () => 'partial-details' }));
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: { request: (_name: string, operation: () => Promise<unknown>) => operation() }
});

let db: Dexie;
let sequence = 0;
beforeEach(async () => {
  db = new Dexie(`recovery-sdk-${sequence++}`);
  db.version(1).stores({ inputNotes: 'detailsCommitment,stateDiscriminant' });
  await db.open();
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

function reader(): RecoverySdkReader {
  return {
    settings: { get: jest.fn().mockResolvedValue('sdk-generation'), set: jest.fn().mockResolvedValue(undefined) },
    accounts: {
      get: jest.fn().mockResolvedValue({
        nonce: () => ({ asInt: () => 3n }),
        to_commitment: () => ({ toHex: () => 'state-3', free: () => {} })
      })
    },
    notes: { list: jest.fn().mockResolvedValue([]) },
    storeIdentifier: jest.fn().mockImplementation(async () => db.name)
  };
}

it('counts only pinned unspent states before reading note bodies', async () => {
  await db.table('inputNotes').bulkAdd(
    Array.from({ length: 9 }, (_, stateDiscriminant) => ({
      detailsCommitment: `${stateDiscriminant}`,
      stateDiscriminant
    }))
  );
  expect(await countRetainedInputNotes(db.name)).toBe(5);
});
it('refuses an oversized baseline before SDK note-body materialization', async () => {
  await db
    .table('inputNotes')
    .bulkAdd(Array.from({ length: 257 }, (_, i) => ({ detailsCommitment: `${i}`, stateDiscriminant: 0 })));
  const client = reader();
  await expect(readSdkRecoverySnapshot(client, ['retained'], true, () => {})).rejects.toThrow('capacity');
  expect(client.notes.list).not.toHaveBeenCalled();
  const health = await import('../storage-health');
  await health.resetStorageHealthForLifecycle(health.getStorageHealth().epoch);
});
it('retains metadata-less private bodies through details-only files', async () => {
  const client = reader();
  client.notes.list = jest
    .fn()
    .mockResolvedValue([])
    .mockResolvedValueOnce([
      {
        metadata: () => undefined,
        details: () => ({}),
        id: () => undefined,
        toInputNote: () => {
          throw new Error('partial');
        }
      }
    ]);
  const result = await readSdkRecoverySnapshot(client, ['retained'], true, () => {});
  expect(result.notes).toEqual([
    { kind: 'note', id: 'partial-details', noteFile: new Uint8Array([3, 4]), provenance: 'input', format: 'details' }
  ]);
});
it('refuses missing retained accounts before collecting a baseline', async () => {
  const client = reader();
  jest.mocked(client.accounts.get).mockResolvedValueOnce(null);
  await expect(readSdkRecoverySnapshot(client, ['retained'], true, () => {})).rejects.toMatchObject({
    name: 'StorageContinuityError'
  });
  expect(client.notes.list).not.toHaveBeenCalled();
});
it('refuses to replace a marker changed by another lifecycle', async () => {
  const client = reader();
  await expect(initializeSdkGeneration(client, 'new', null, () => {})).rejects.toThrow();
  expect(client.settings.set).not.toHaveBeenCalled();
});
it('verifies a newly initialized marker before returning success', async () => {
  const client = reader();
  jest.mocked(client.settings.get).mockResolvedValueOnce(null).mockResolvedValueOnce('wrong');
  await expect(initializeSdkGeneration(client, 'new', null, () => {})).rejects.toThrow();
});

it('refuses recovery when a retained private input body has disappeared', async () => {
  const client = reader();
  await expect(
    readSdkRecoverySnapshot(client, ['retained'], false, () => {}, [
      { kind: 'note', id: 'missing-input', noteFile: new Uint8Array([1, 2]), provenance: 'input', format: 'full' }
    ])
  ).rejects.toThrow('Storage continuity unavailable');
});
