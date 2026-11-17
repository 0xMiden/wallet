import { isExtensionServiceWorkerSender, type MessageSenderLike } from 'lib/intercom/sender';
import { getTestAuthorizationStorage } from 'lib/miden/sdk/test-authorization-storage';
import { isRecord } from 'lib/update/guards';

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
  const onChanged = (
    message: unknown,
    sender: MessageSenderLike,
    sendResponse: (response: unknown) => void
  ): boolean => {
    if (
      !isRecord(message) ||
      message.target !== 'offscreen-fetch-faults' ||
      message.type !== OFFSCREEN_FETCH_FAULTS_KEY
    )
      return false;
    const workerPath = chrome.runtime.getManifest().background?.service_worker;
    if (
      !isExtensionServiceWorkerSender(sender, chrome.runtime.id) &&
      !(
        typeof workerPath === 'string' &&
        sender?.id === chrome.runtime.id &&
        sender.tab === undefined &&
        sender.url === chrome.runtime.getURL(workerPath)
      )
    )
      return false;
    changed = true;
    latest = message.value;
    apply(latest);
    sendResponse({ ok: true });
    return false;
  };
  // Offscreen has runtime only. Subscribe before the SW read so a newer clear/rearm wins.
  chrome.runtime.onMessage.addListener(onChanged);
  try {
    const stored = await getTestAuthorizationStorage(OFFSCREEN_FETCH_FAULTS_KEY);
    apply(changed ? latest : stored[OFFSCREEN_FETCH_FAULTS_KEY]);
  } catch (error) {
    chrome.runtime.onMessage.removeListener(onChanged);
    throw error;
  }
}
