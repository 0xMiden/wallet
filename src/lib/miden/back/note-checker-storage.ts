const STORAGE_KEY = 'miden_seen_note_ids';

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
