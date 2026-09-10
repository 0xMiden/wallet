import { useEffect, useState } from 'react';

import Dexie from 'dexie';

interface StoredInputNote {
  noteId?: string;
  serializedCreatedAt?: string;
}

export async function readStoredNoteDates(noteIds: string[]): Promise<Map<string, number>> {
  const dates = new Map<string, number>();
  if (noteIds.length === 0 || typeof indexedDB === 'undefined') return dates;
  for (const name of await Dexie.getDatabaseNames()) {
    const db = new Dexie(name);
    try {
      await db.open();
      const table = db.tables.find(candidate => candidate.name === 'inputNotes');
      if (!table) continue;
      const notes = await db.table<StoredInputNote>('inputNotes').where('noteId').anyOf(noteIds).toArray();
      for (const note of notes) {
        if (!note.noteId || !note.serializedCreatedAt) continue;
        const seconds = Number(note.serializedCreatedAt);
        if (Number.isFinite(seconds) && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime())) {
          dates.set(note.noteId, seconds);
        }
      }
    } finally {
      db.close();
    }
  }
  return dates;
}

export function useActivityNoteDates(noteIds: string[]): ReadonlyMap<string, number> {
  const [dates, setDates] = useState<ReadonlyMap<string, number>>(new Map());
  const signature = noteIds.join(',');
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const stored = await readStoredNoteDates(signature ? signature.split(',') : []);
        if (cancelled) return;
        setDates(previous => {
          if ([...stored].every(([id, date]) => previous.get(id) === date)) return previous;
          return new Map([...previous, ...stored]);
        });
      } catch (error) {
        console.warn('[activity] Could not read stored note dates', error);
      }
    };
    read();
    const timer = setInterval(read, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [signature]);
  return dates;
}
