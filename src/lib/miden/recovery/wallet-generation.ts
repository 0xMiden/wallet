import { StorageContinuityError, type WalletStoreGeneration } from './continuity';

export function validateWalletGeneration(value: unknown): WalletStoreGeneration {
  if (typeof value !== 'object' || value === null) throw new StorageContinuityError();
  const id: unknown = Reflect.get(value, 'id');
  const generation: unknown = Reflect.get(value, 'generation');
  const origin: unknown = Reflect.get(value, 'origin');
  if (
    id !== 'generation' ||
    typeof generation !== 'string' ||
    !generation ||
    (origin !== 'fresh' && origin !== 'migrated' && origin !== 'authorized')
  )
    throw new StorageContinuityError();
  return { id, generation, origin };
}

/** Opening a missing database aborts its upgrade; recovery never creates the marker it is checking. */
export function readWalletGenerationForRecovery(name: string): Promise<WalletStoreGeneration> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      request.result.close();
    };
    request.onerror = () => reject(new StorageContinuityError());
    request.onsuccess = () => {
      const database = request.result;
      try {
        const tx = database.transaction('metadata', 'readonly');
        const get = tx.objectStore('metadata').get('generation');
        let marker: WalletStoreGeneration | undefined;
        get.onsuccess = () => {
          try {
            marker = validateWalletGeneration(get.result);
          } catch {
            tx.abort();
          }
        };
        tx.oncomplete = () => {
          database.close();
          marker ? resolve(marker) : reject(new StorageContinuityError());
        };
        tx.onabort = () => {
          database.close();
          reject(new StorageContinuityError());
        };
      } catch {
        database.close();
        reject(new StorageContinuityError());
      }
    };
  });
}
