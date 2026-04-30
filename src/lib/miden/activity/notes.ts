import { fetchFromStorage, putToStorage } from '../front';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

const IMPORT_NOTES_KEY = 'miden-notes-pending-import';

export const queueNoteImport = async (noteBytes: string) => {
  const queuedImports = (await fetchFromStorage<string[]>(IMPORT_NOTES_KEY)) || [];
  await putToStorage(IMPORT_NOTES_KEY, [...queuedImports, noteBytes]);
};

export const importAllNotes = async () => {
  const queuedImports: string[] = (await fetchFromStorage<string[]>(IMPORT_NOTES_KEY)) || [];
  if (queuedImports.length === 0) {
    return;
  }
  // Wrap all WASM client operations in a lock to prevent concurrent access
  await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    for (const noteBytes of queuedImports) {
      const byteArray = new Uint8Array(Buffer.from(noteBytes, 'base64'));
      await midenClient.importNoteBytes(byteArray);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
    await midenClient.syncState();
  }, 'notes.import');
  await putToStorage(IMPORT_NOTES_KEY, []);
};
