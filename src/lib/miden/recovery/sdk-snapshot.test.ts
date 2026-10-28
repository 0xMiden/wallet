import Dexie from 'dexie';

import {
  countRetainedInputNotes,
  readSdkRecoverySnapshot,
  readSdkGeneration,
  initializeSdkGeneration,
  type RecoverySdkReader
} from './sdk-snapshot';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteType: { Private: 0, Public: 1 },
  NoteFile: {
    deserialize: () => ({
      noteDetails: () => undefined,
      note: () => ({}),
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

describe('SDK generation byte contract', () => {
  it('reads an SDK byte-array marker', async () => {
    const client = reader();
    jest.mocked(client.settings.get).mockResolvedValueOnce([115, 100, 107]);
    await expect(readSdkGeneration(client)).resolves.toBe('sdk');
  });

  it('writes and reads back a marker using SDK byte values', async () => {
    const client = reader();
    let stored: number[] | null = null;
    jest.mocked(client.settings.get).mockImplementation(async () => stored);
    jest.mocked(client.settings.set).mockImplementation(async (_key, value) => {
      if (!Array.isArray(value) || !value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255))
        throw new Error('SDK setting requires bytes');
      stored = value;
    });
    await expect(initializeSdkGeneration(client, 'new', null, () => {})).resolves.toBeUndefined();
    expect(stored).toEqual([110, 101, 119]);
  });

  it.each([
    { bytes: [255] },
    { bytes: [192, 128] },
    { bytes: [256] },
    { bytes: [-1] },
    { bytes: [1.5] },
    { bytes: [] }
  ])('refuses malformed marker bytes', async ({ bytes }) => {
    const client = reader();
    jest.mocked(client.settings.get).mockResolvedValueOnce(bytes);
    await expect(readSdkGeneration(client)).rejects.toMatchObject({ name: 'StorageContinuityError' });
  });

  it('refuses a plain string from the SDK byte setting', async () => {
    const client = reader();
    jest.mocked(client.settings.get).mockResolvedValueOnce('sdk');
    await expect(readSdkGeneration(client)).rejects.toMatchObject({ name: 'StorageContinuityError' });
  });
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
    notes: {
      list: jest.fn().mockResolvedValue([]),
      listPage: jest.fn().mockResolvedValue({ notes: [], nextCursor: null, exhausted: true })
    },
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
it('refuses an oversized private baseline without unbounded SDK note-body materialization', async () => {
  await db
    .table('inputNotes')
    .bulkAdd(Array.from({ length: 257 }, (_, i) => ({ detailsCommitment: `${i}`, stateDiscriminant: 0 })));
  const client = reader();
  const records = Array.from({ length: 257 }, (_, index) => ({
    metadata: () => ({ noteType: () => 0, free: () => {} }),
    details: () => ({ free: () => {} }),
    id: () => ({ toString: () => `0x${index.toString(16).padStart(64, '0')}`, free: () => {} }),
    toInputNote: () => ({ free: () => {} }),
    free: () => {}
  }));
  const listPage = jest
    .fn()
    .mockResolvedValueOnce({ notes: records.slice(0, 128), nextCursor: '0x' + '11'.repeat(32), exhausted: false })
    .mockResolvedValueOnce({ notes: records.slice(128, 256), nextCursor: '0x' + '22'.repeat(32), exhausted: false })
    .mockResolvedValueOnce({ notes: records.slice(256), nextCursor: '0x' + '33'.repeat(32), exhausted: true });
  client.notes.listPage = listPage;
  await expect(readSdkRecoverySnapshot(client, ['retained'], true, () => {})).rejects.toThrow('capacity');
  expect(client.notes.list).not.toHaveBeenCalled();
  expect(listPage).toHaveBeenCalledTimes(3);
  const health = await import('../storage-health');
  await health.resetStorageHealthForLifecycle(health.getStorageHealth().epoch);
});
it('retains metadata-less private bodies through details-only files', async () => {
  const client = reader();
  client.notes.listPage = jest.fn().mockResolvedValueOnce({
    notes: [
      {
        metadata: () => undefined,
        details: () => ({ free: () => {} }),
        id: () => undefined,
        toInputNote: () => {
          throw new Error('partial');
        },
        free: () => {}
      }
    ],
    nextCursor: '0x' + '11'.repeat(32),
    exhausted: true
  });
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

describe('Task4C3I bounded recovery baseline', () => {
  const cursorA = '0x' + '11'.repeat(32);
  const cursorB = '0x' + '22'.repeat(32);
  const privateId = '0x' + '33'.repeat(32);
  const unknownId = '0x' + '44'.repeat(32);
  const states = ['expected', 'unverified', 'committed', 'processing'];

  afterEach(async () => {
    const health = await import('../storage-health');
    await health.resetStorageHealthForLifecycle(health.getStorageHealth().epoch);
  });

  function record(id: string | undefined, noteType?: number, partial = false) {
    return {
      metadata: jest.fn(() => (noteType === undefined ? undefined : { noteType: () => noteType, free: jest.fn() })),
      details: jest.fn(() => ({ free: jest.fn() })),
      id: jest.fn(() => (id === undefined ? undefined : { toString: () => id, free: jest.fn() })),
      toInputNote: jest.fn(() => {
        if (partial) throw new Error('Partial note has no metadata');
        return { free: jest.fn() };
      }),
      free: jest.fn()
    };
  }

  function pagedReader() {
    const list = jest.fn().mockResolvedValue([]);
    const listPage = jest.fn().mockResolvedValue({ notes: [], nextCursor: null, exhausted: true });
    return { ...reader(), notes: { list, listPage } };
  }

  it('advances an empty filtered page using its exact returned cursor and bounded query', async () => {
    const client = pagedReader();
    client.notes.listPage
      .mockResolvedValueOnce({ notes: [], nextCursor: cursorA, exhausted: false })
      .mockResolvedValueOnce({ notes: [record(privateId, 0)], nextCursor: cursorB, exhausted: true });
    const result = await readSdkRecoverySnapshot(client, ['retained'], true, () => {});
    expect(result.notes).toEqual([
      { kind: 'note', id: privateId, noteFile: new Uint8Array([1, 2]), provenance: 'input', format: 'full' }
    ]);
    expect(client.notes.listPage).toHaveBeenNthCalledWith(1, { states, limit: 128 });
    expect(client.notes.listPage).toHaveBeenNthCalledWith(2, {
      states,
      limit: 128,
      afterDetailsCommitment: cursorA
    });
    expect(client.notes.list).not.toHaveBeenCalled();
  });

  it('does not charge 257 positively public rows against one required private body', async () => {
    await db
      .table('inputNotes')
      .bulkAdd(Array.from({ length: 258 }, (_, i) => ({ detailsCommitment: `${i}`, stateDiscriminant: 2 })));
    const client = pagedReader();
    const publicRecords = Array.from({ length: 257 }, (_, index) =>
      record(`0x${index.toString(16).padStart(64, '0')}`, 1)
    );
    client.notes.listPage
      .mockResolvedValueOnce({ notes: publicRecords.slice(0, 128), nextCursor: cursorA, exhausted: false })
      .mockResolvedValueOnce({ notes: publicRecords.slice(128, 256), nextCursor: cursorB, exhausted: false })
      .mockResolvedValueOnce({
        notes: [publicRecords[256], record(privateId, 0)],
        nextCursor: privateId,
        exhausted: true
      });
    const outcome = await readSdkRecoverySnapshot(client, ['retained'], true, () => {}).then(
      value => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value?.notes).toEqual([
      { kind: 'note', id: privateId, noteFile: new Uint8Array([1, 2]), provenance: 'input', format: 'full' }
    ]);
    expect(client.notes.listPage).toHaveBeenCalledTimes(3);
    expect(publicRecords.every(value => value.toInputNote.mock.calls.length === 0)).toBe(true);
    expect(client.notes.list).not.toHaveBeenCalled();
    const health = await import('../storage-health');
    expect(health.getStorageHealth().status).toBe('healthy');
  });

  it('preserves private metadata-unknown and partial bodies while excluding only known public bodies', async () => {
    const client = pagedReader();
    const records = [record(privateId, 0), record(unknownId), record(undefined, undefined, true), record(cursorA, 1)];
    client.notes.list.mockResolvedValueOnce(records);
    client.notes.listPage.mockResolvedValueOnce({ notes: records, nextCursor: cursorB, exhausted: true });
    const result = await readSdkRecoverySnapshot(client, ['retained'], true, () => {});
    expect(result.notes).toEqual([
      { kind: 'note', id: privateId, noteFile: new Uint8Array([1, 2]), provenance: 'input', format: 'full' },
      { kind: 'note', id: unknownId, noteFile: new Uint8Array([1, 2]), provenance: 'input', format: 'full' },
      { kind: 'note', id: 'partial-details', noteFile: new Uint8Array([3, 4]), provenance: 'input', format: 'details' }
    ]);
    expect(records[3]?.toInputNote).not.toHaveBeenCalled();
    const health = await import('../storage-health');
    expect(health.getStorageHealth().status).toBe('healthy');
  });

  it('never silently excludes an unexpected metadata visibility value as public', async () => {
    const client = pagedReader();
    const unknown = record(unknownId, 2);
    client.notes.list.mockResolvedValueOnce([unknown]);
    client.notes.listPage.mockResolvedValueOnce({ notes: [unknown], nextCursor: cursorA, exhausted: true });
    const outcome = await readSdkRecoverySnapshot(client, ['retained'], true, () => {}).then(
      value => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    expect(outcome.error !== undefined || outcome.value?.notes.some(note => note.id === unknownId)).toBe(true);
    const health = await import('../storage-health');
    expect(health.getStorageHealth().status).toBe('healthy');
  });

  it.each([cursorB, cursorA])(
    'refuses a nonprogressing page cursor %s before accepting a baseline',
    async nextCursor => {
      const client = pagedReader();
      client.notes.listPage
        .mockResolvedValueOnce({ notes: [], nextCursor: cursorB, exhausted: false })
        .mockResolvedValueOnce({ notes: [], nextCursor, exhausted: false });
      const outcome = await readSdkRecoverySnapshot(client, ['retained'], true, () => {}).then(
        () => 'accepted',
        () => 'refused'
      );
      expect(outcome).toBe('refused');
      expect(client.notes.listPage).toHaveBeenCalledTimes(2);
      expect(client.settings.set).not.toHaveBeenCalled();
    }
  );

  it('refuses a generation changed while reading the paged baseline', async () => {
    const client = pagedReader();
    jest.mocked(client.settings.get).mockResolvedValueOnce('sdk-generation').mockResolvedValue('replaced-generation');
    client.notes.listPage.mockResolvedValueOnce({
      notes: [record(privateId, 0)],
      nextCursor: cursorA,
      exhausted: true
    });
    const outcome = await readSdkRecoverySnapshot(client, ['retained'], true, () => {}).then(
      () => 'accepted',
      () => 'refused'
    );
    expect(outcome).toBe('refused');
    expect(client.notes.listPage).toHaveBeenCalledTimes(1);
    expect(client.settings.set).not.toHaveBeenCalled();
  });

  it('checks owner retirement immediately after the page await and before materializing its body', async () => {
    const client = pagedReader();
    const retained = record(privateId, 0);
    let owned = true;
    client.notes.listPage.mockImplementationOnce(async () => {
      owned = false;
      return { notes: [retained], nextCursor: cursorA, exhausted: true };
    });
    const outcome = await readSdkRecoverySnapshot(client, ['retained'], true, () => {
      if (!owned) throw new Error('Originating owner retired');
    }).then(
      () => 'accepted',
      () => 'refused'
    );
    expect(outcome).toBe('refused');
    expect(client.notes.listPage).toHaveBeenCalledTimes(1);
    expect(retained.toInputNote).not.toHaveBeenCalled();
    expect(client.settings.set).not.toHaveBeenCalled();
    const health = await import('../storage-health');
    expect(health.getStorageHealth().status).toBe('healthy');
  });

  it('refuses an incomplete baseline after 128 raw pages without poisoning storage health', async () => {
    const client = pagedReader();
    let pages = 0;
    client.notes.listPage.mockImplementation(async () => ({
      notes: [],
      nextCursor: `0x${(++pages).toString(16).padStart(64, '0')}`,
      exhausted: false
    }));
    const outcome = await readSdkRecoverySnapshot(client, ['retained'], true, () => {}).then(
      () => 'accepted',
      () => 'refused'
    );
    expect(outcome).toBe('refused');
    expect(client.notes.listPage).toHaveBeenCalledTimes(128);
    expect(client.settings.set).not.toHaveBeenCalled();
    const health = await import('../storage-health');
    expect(health.getStorageHealth().status).toBe('healthy');
  });

  it('refuses an incomplete baseline at the five-second monotonic deadline after a page await', async () => {
    const client = pagedReader();
    let elapsed = 0;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => elapsed);
    client.notes.listPage.mockImplementation(async () => {
      elapsed += 1000;
      return { notes: [], nextCursor: `0x${elapsed.toString(16).padStart(64, '0')}`, exhausted: false };
    });
    try {
      const outcome = await readSdkRecoverySnapshot(client, ['retained'], true, () => {}).then(
        () => 'accepted',
        () => 'refused'
      );
      expect(outcome).toBe('refused');
      expect(client.notes.listPage).toHaveBeenCalledTimes(5);
      expect(client.settings.set).not.toHaveBeenCalled();
      const health = await import('../storage-health');
      expect(health.getStorageHealth().status).toBe('healthy');
    } finally {
      now.mockRestore();
    }
  });

  it('does not release a partial baseline to its checkpoint caller while a required page is pending', async () => {
    const client = pagedReader();
    let release = () => {};
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered = () => {};
    const atPage = new Promise<void>(resolve => {
      entered = resolve;
    });
    client.notes.listPage
      .mockResolvedValueOnce({ notes: [record(privateId, 0)], nextCursor: cursorA, exhausted: false })
      .mockImplementationOnce(async () => {
        entered();
        await pending;
        return { notes: [record(unknownId)], nextCursor: cursorB, exhausted: true };
      });
    const completed = jest.fn();
    const outcome = readSdkRecoverySnapshot(client, ['retained'], true, () => {}).then(value => {
      completed(value);
      return value;
    });
    try {
      expect(await Promise.race([atPage.then(() => true), outcome.then(() => false)])).toBe(true);
      expect(completed).not.toHaveBeenCalled();
      release();
      expect((await outcome).notes).toEqual([
        { kind: 'note', id: privateId, noteFile: new Uint8Array([1, 2]), provenance: 'input', format: 'full' },
        { kind: 'note', id: unknownId, noteFile: new Uint8Array([1, 2]), provenance: 'input', format: 'full' }
      ]);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(client.settings.set).not.toHaveBeenCalled();
    } finally {
      release();
      await outcome;
    }
  });
});
