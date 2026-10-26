// Lock order: accounts queue, WASM hold, then independent storage. Never wait for WASM inside this lock.
export function withRecoveryStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void navigator.locks
      .request('miden-recovery-storage-v1', async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      })
      .catch(reject);
  });
}
