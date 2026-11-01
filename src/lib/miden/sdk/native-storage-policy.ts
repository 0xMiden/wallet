import { getWasmOrThrow, NoteAcquisitionRetentionError, type IndexedDbOptions } from '@miden-sdk/miden-sdk/lazy';

import { markStorageUnavailable, type StorageHealthOperation } from '../storage-health';

export async function nativeStorageName(rpcUrl: string, mock = false): Promise<string> {
  const wasm = await getWasmOrThrow();
  if (
    typeof NoteAcquisitionRetentionError !== 'function' ||
    typeof wasm.WebClient?.prototype?.installNoteAcquisitionGate !== 'function'
  )
    throw new Error('Required native storage protection unavailable');
  // The SDK mock factory has a fixed namespace rather than an endpoint-derived store.
  return mock ? 'mock_client_db' : wasm.resolveStoreName(rpcUrl, undefined);
}

function operationForPhase(phase: unknown): StorageHealthOperation | undefined {
  switch (phase) {
    case 'open':
      return 'open';
    case 'read':
      return 'query';
    case 'write':
      return 'mutate';
    case 'commit':
      return 'transaction';
    default:
      return undefined;
  }
}

function failureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nativeStoragePolicy(storeName: string, isCurrent: () => boolean): IndexedDbOptions {
  const recent = new Set<string>();
  return {
    durability: 'strict',
    onFailure: (failure: unknown) => {
      if (
        !isCurrent() ||
        !failureRecord(failure) ||
        Object.keys(failure).some(
          key => !['backend', 'storeName', 'phase', 'operation', 'kind', 'errorName', 'eventId'].includes(key)
        ) ||
        failure.backend !== 'indexeddb' ||
        failure.storeName !== storeName ||
        typeof failure.phase !== 'string' ||
        failure.operation !== `indexeddb.${failure.phase}` ||
        typeof failure.eventId !== 'string' ||
        failure.eventId.length === 0 ||
        failure.eventId.length > 128 ||
        recent.has(failure.eventId)
      )
        return;
      const operation = operationForPhase(failure.phase);
      const matches =
        (failure.kind === 'quota' && failure.errorName === 'QuotaExceededError') ||
        (failure.kind === 'io' && failure.errorName === 'UnknownError') ||
        (failure.kind === 'unavailable' &&
          ['SecurityError', 'InvalidStateError', 'MissingAPIError'].some(name => name === failure.errorName)) ||
        (failure.kind === 'unexpected-abort' && failure.errorName === 'AbortError');
      if (!operation || !matches) return;
      recent.add(failure.eventId);
      if (recent.size > 64) {
        const oldest = recent.values().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
      markStorageUnavailable(failure.kind === 'quota' ? 'quota' : 'backing-store', { backend: 'sdk', operation });
    }
  };
}
