import { SerializedConsumableNote } from 'lib/shared/types';

const STORAGE_KEY = 'miden_seen_note_ids';
const NOTES_CACHE_KEY = 'miden_cached_consumable_notes';

async function getBrowserStorage() {
  const browser = await import('webextension-polyfill');
  return browser.default.storage.local;
}

export async function getPersistedSeenNoteIds(): Promise<Set<string>> {
  const storage = await getBrowserStorage();
  const result = await storage.get(STORAGE_KEY);
  const ids = (result[STORAGE_KEY] as string[] | undefined) ?? [];
  return new Set(ids);
}

export async function persistSeenNoteIds(ids: Set<string>): Promise<void> {
  const storage = await getBrowserStorage();
  await storage.set({ [STORAGE_KEY]: Array.from(ids) });
}

/**
 * Merges current note IDs with persisted ones.
 * Prunes IDs no longer in the current consumable set (claimed/expired).
 * Returns the list of newly seen IDs.
 */
export async function mergeAndPersistSeenNoteIds(currentIds: string[]): Promise<string[]> {
  const persisted = await getPersistedSeenNoteIds();

  // Find new IDs not previously seen
  const newIds = currentIds.filter(id => !persisted.has(id));

  // Prune: only keep IDs that are still in the current consumable set
  const merged = new Set(currentIds);
  await persistSeenNoteIds(merged);

  return newIds;
}

export async function clearPersistedSeenNoteIds(): Promise<void> {
  const storage = await getBrowserStorage();
  await storage.remove(STORAGE_KEY);
}

// ---- Consumable notes cache (for instant display on notification click) ----

export async function cacheConsumableNotes(notes: SerializedConsumableNote[]): Promise<void> {
  const storage = await getBrowserStorage();
  await storage.set({ [NOTES_CACHE_KEY]: notes });
}

export async function getCachedConsumableNotes(): Promise<SerializedConsumableNote[]> {
  const storage = await getBrowserStorage();
  const result = await storage.get(NOTES_CACHE_KEY);
  return (result[NOTES_CACHE_KEY] as SerializedConsumableNote[] | undefined) ?? [];
}

export async function clearCachedConsumableNotes(): Promise<void> {
  const storage = await getBrowserStorage();
  await storage.remove(NOTES_CACHE_KEY);
}
