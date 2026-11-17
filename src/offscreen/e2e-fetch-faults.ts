import {
  installFetchInstrumentation,
  OFFSCREEN_FETCH_FAULTS_KEY,
  SW_FETCH_LOG_PREFIX
} from '../../playwright/e2e/harness/fetch-instrumentation';
import type { FetchFaultWire } from '../../playwright/e2e/harness/network-faults';

function isFault(value: unknown): value is FetchFaultWire {
  if (typeof value !== 'object' || value === null) return false;
  const id: unknown = Reflect.get(value, 'id');
  const host: unknown = Reflect.get(value, 'host');
  const mode: unknown = Reflect.get(value, 'mode');
  const path: unknown = Reflect.get(value, 'path');
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof host === 'string' &&
    host.length > 0 &&
    typeof mode === 'string' &&
    [
      'status500',
      'status429RetryAfter',
      'abort',
      'connectionRefused',
      'timeout',
      'hang',
      'delay',
      'slowStream',
      'truncatedBody',
      'malformedBody',
      'failFirstN'
    ].includes(mode) &&
    (path === undefined || typeof path === 'string') &&
    ['count', 'delayMs', 'retryAfterSec'].every(key => {
      const number: unknown = Reflect.get(value, key);
      return number === undefined || (typeof number === 'number' && Number.isFinite(number) && number >= 0);
    })
  );
}

function apply(value: unknown): void {
  const wire: unknown = value === undefined ? [] : value;
  if (!Array.isArray(wire) || !wire.every(isFault)) throw new Error('Invalid persisted offscreen fetch faults');
  Reflect.set(globalThis, '__E2E_NET_FAULTS', wire);
  if (wire.length) installFetchInstrumentation(SW_FETCH_LOG_PREFIX);
}

export async function restoreOffscreenFetchFaults(): Promise<void> {
  let changed = false;
  let latest: unknown;
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !(OFFSCREEN_FETCH_FAULTS_KEY in changes)) return;
    changed = true;
    latest = changes[OFFSCREEN_FETCH_FAULTS_KEY].newValue;
    apply(latest);
  };
  // Subscribe before reading so a clear/rearm cannot lose to an older startup snapshot.
  chrome.storage.onChanged.addListener(onChanged);
  try {
    const stored = await chrome.storage.local.get(OFFSCREEN_FETCH_FAULTS_KEY);
    apply(changed ? latest : stored[OFFSCREEN_FETCH_FAULTS_KEY]);
  } catch (error) {
    chrome.storage.onChanged.removeListener(onChanged);
    throw error;
  }
}
