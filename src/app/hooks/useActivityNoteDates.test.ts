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
