import Dexie from 'dexie';

import { readStoredNoteDates } from './useActivityNoteDates';

it('reads the saved receive date for notes that predate the new sync field', async () => {
  const db = new Dexie('activity-note-date-test');
  db.version(1).stores({ inputNotes: '&noteId' });
  try {
    await db.table('inputNotes').bulkPut([
      { noteId: 'older', serializedCreatedAt: '1705316400' },
      { noteId: 'newer', serializedCreatedAt: '1705402800' },
      { noteId: 'bad', serializedCreatedAt: 'not-a-date' },
      { noteId: 'unrelated', serializedCreatedAt: '1705402800' }
    ]);
    expect(await readStoredNoteDates(['older', 'newer', 'bad'])).toEqual(
      new Map([
        ['older', 1705316400],
        ['newer', 1705402800]
      ])
    );
  } finally {
    await db.delete();
  }
});

it('returns immediately for an empty note list', async () => {
  expect(await readStoredNoteDates([])).toEqual(new Map());
});

it('skips databases without input notes and malformed stored rows', async () => {
  const unrelated = new Dexie('activity-note-date-unrelated-test');
  unrelated.version(1).stores({ other: '&id' });
  const malformed = new Dexie('activity-note-date-malformed-test');
  malformed.version(1).stores({ inputNotes: '&key,noteId' });
  try {
    await unrelated.table('other').put({ id: 'value' });
    await malformed.table('inputNotes').bulkPut([
      { key: 'missing-id', serializedCreatedAt: '1705316400' },
      { key: 'missing-date', noteId: 'missing-date' },
      { key: 'zero', noteId: 'zero', serializedCreatedAt: '0' },
      { key: 'infinite', noteId: 'infinite', serializedCreatedAt: 'Infinity' },
      { key: 'invalid-date', noteId: 'invalid-date', serializedCreatedAt: '999999999999999999999999999' }
    ]);
    expect(await readStoredNoteDates(['missing-date', 'zero', 'infinite', 'invalid-date'])).toEqual(new Map());
  } finally {
    await unrelated.delete();
    await malformed.delete();
  }
});
