import { act, renderHook, waitFor } from '@testing-library/react';
import Dexie from 'dexie';

import { readStoredNoteDates, useActivityNoteDates } from './useActivityNoteDates';

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

it('publishes stored dates through the hook and keeps an unchanged result stable', async () => {
  const db = new Dexie('activity-note-date-hook-test');
  const names = jest.spyOn(Dexie, 'getDatabaseNames');
  db.version(1).stores({ inputNotes: '&noteId' });
  try {
    await db.table('inputNotes').put({ noteId: 'hook-note', serializedCreatedAt: '1705316400' });
    const { result, rerender } = renderHook(({ ids }) => useActivityNoteDates(ids), {
      initialProps: { ids: ['hook-note'] }
    });
    await waitFor(() => expect(result.current.get('hook-note')).toBe(1705316400));
    const published = result.current;
    const reads = names.mock.calls.length;
    rerender({ ids: ['hook-note', 'missing'] });
    await waitFor(() => expect(names.mock.calls.length).toBeGreaterThan(reads));
    expect(result.current).toBe(published);
  } finally {
    names.mockRestore();
    await db.delete();
  }
});

it('returns an empty stable map for an empty hook query', async () => {
  const { result } = renderHook(() => useActivityNoteDates([]));
  const initial = result.current;
  await act(async () => {});
  expect(result.current).toBe(initial);
  expect(result.current.size).toBe(0);
});

it('logs a database-list failure without replacing the current dates', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const names = jest.spyOn(Dexie, 'getDatabaseNames').mockRejectedValueOnce(new Error('IndexedDB unavailable'));
  const { result } = renderHook(() => useActivityNoteDates(['note']));

  await waitFor(() =>
    expect(log).toHaveBeenCalledWith('[activity] Could not read stored note dates', expect.any(Error))
  );
  expect(result.current.size).toBe(0);
  names.mockRestore();
  log.mockRestore();
});
