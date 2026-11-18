import { getStorageProvider } from 'lib/platform/storage-adapter';

import { inStorageTurn, putToStorage } from './front/storage';

export const WALLET_STORAGE_FAILURE_KEY = 'miden_wallet_storage_failure_v1';

let pendingFailure: string | undefined;
const listeners = new Set<() => void>();

export function onWalletStorageChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyWalletStorageChanged() {
  for (const listener of listeners) listener();
}

export async function getWalletStorageFailure(): Promise<string | undefined> {
  if (pendingFailure) return pendingFailure;
  const stored: unknown = (await getStorageProvider().get([WALLET_STORAGE_FAILURE_KEY]))[WALLET_STORAGE_FAILURE_KEY];
  if (pendingFailure) return pendingFailure;
  if (stored !== undefined && stored !== null && typeof stored !== 'string') throw new WalletStorageUnavailableError();
  return typeof stored === 'string' ? stored : undefined;
}

export async function markWalletStorageUnavailable(): Promise<void> {
  const failure = crypto.randomUUID();
  pendingFailure = failure;
  notifyWalletStorageChanged();
  try {
    await inStorageTurn(WALLET_STORAGE_FAILURE_KEY, async () => {
      if (pendingFailure !== failure) return;
      await putToStorage(WALLET_STORAGE_FAILURE_KEY, failure);
      if (pendingFailure === failure) pendingFailure = undefined;
    });
  } catch {
    // Even when free space prevents this write, this realm must stop.
  }
}

export class WalletStorageUnavailableError extends Error {
  constructor() {
    super('Wallet storage unavailable');
    this.name = 'WalletStorageUnavailableError';
  }
}

export async function assertWalletStorageAvailable(): Promise<void> {
  if (await getWalletStorageFailure()) throw new WalletStorageUnavailableError();
}

export function observeWalletStorageError(error: unknown): void {
  for (let cause = error, depth = 0; typeof cause === 'object' && cause !== null && depth < 5; depth++) {
    const {
      name,
      message,
      cause: next,
      inner
    } = cause as {
      name?: string;
      message?: string;
      cause?: unknown;
      inner?: unknown;
    };
    if (
      name === 'QuotaExceededError' ||
      (name === 'UnknownError' &&
        /backing[ -]store|I\/?O error|FILE_ERROR_NO_SPACE|database.*corrupt/i.test(message ?? ''))
    ) {
      void markWalletStorageUnavailable();
      return;
    }
    cause = next ?? inner;
  }
}

export async function clearVerifiedStorageFailure(expected: string): Promise<void> {
  await inStorageTurn(WALLET_STORAGE_FAILURE_KEY, async () => {
    if ((await getWalletStorageFailure()) !== expected) throw new WalletStorageUnavailableError();
    await putToStorage(WALLET_STORAGE_FAILURE_KEY, null);
    if (pendingFailure && pendingFailure !== expected) throw new WalletStorageUnavailableError();
    pendingFailure = undefined;
  });
  notifyWalletStorageChanged();
}
