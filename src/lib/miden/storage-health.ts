import { getStorageProvider } from 'lib/platform/storage-adapter';

import { isInOffscreenDocument } from './back/offscreen-realm';

export const STORAGE_HEALTH_KEY = 'miden_storage_health_v1';
export type StorageFailureReason = 'quota' | 'backing-store' | 'continuity' | 'journal';
export type StorageBackend = 'wallet' | 'sdk' | 'independent';
export type StorageHealthOperation =
  | 'open'
  | 'get'
  | 'query'
  | 'count'
  | 'cursor'
  | 'mutate'
  | 'transaction'
  | 'sync'
  | 'import'
  | 'submit'
  | 'validate';
export interface StorageFailureContext {
  backend: StorageBackend;
  operation: StorageHealthOperation;
}
export type StorageHealth =
  | { readonly status: 'healthy'; readonly epoch: number }
  | {
      readonly status: 'unavailable';
      readonly epoch: number;
      readonly reason: StorageFailureReason;
      readonly backend: StorageBackend;
      readonly operation: StorageHealthOperation;
      readonly time: number;
    };

export type StorageAvailability = { readonly status: 'pending' } | StorageHealth;

let hydrated = false;
let snapshot: StorageHealth = { status: 'healthy', epoch: 0 };
export interface StorageRecoveryCapability {
  readonly epoch: number;
  readonly expiresAt: number;
}
const recoveryCapabilities = new WeakMap<StorageRecoveryCapability, number>();

export function assertStorageRecoveryAllowed(capability: StorageRecoveryCapability): void {
  if (
    recoveryCapabilities.get(capability) !== failureRevision ||
    capability.epoch !== snapshot.epoch ||
    Date.now() >= capability.expiresAt
  )
    throw new StorageUnavailableError();
}

export function captureStorageRecoveryGuard(): () => void {
  const epoch = snapshot.epoch;
  const revision = failureRevision;
  const expiresAt = Date.now() + 30_000;
  return () => {
    if (snapshot.epoch !== epoch || failureRevision !== revision || Date.now() >= expiresAt)
      throw new StorageUnavailableError();
  };
}

interface ConfirmedStorageFailure {
  readonly epoch: number;
  readonly revision: number;
  readonly backend: StorageBackend;
  readonly operation: StorageHealthOperation;
}
const confirmedStorageFailures = new WeakMap<object, ConfirmedStorageFailure>();

export function confirmStorageFailure(
  error: unknown,
  reason: StorageFailureReason,
  context: StorageFailureContext,
  expectedEpoch: number
): void {
  if (snapshot.status !== 'healthy' || snapshot.epoch !== expectedEpoch) return;
  markStorageUnavailable(reason, context);
  if (typeof error === 'object' && error !== null)
    confirmedStorageFailures.set(error, { epoch: snapshot.epoch, revision: failureRevision, ...context });
}

let failureRevision = 0;
let transportLoader: (() => Promise<unknown>) | undefined;
let initialization: Promise<void> | undefined;
let persistence = Promise.resolve();
const listeners = new Set<(health: StorageHealth) => void>();
const availabilityListeners = new Set<(availability: StorageAvailability) => void>();
let channel: BroadcastChannel | undefined;
function isReason(value: unknown): value is StorageFailureReason {
  return value === 'quota' || value === 'backing-store' || value === 'continuity' || value === 'journal';
}
function isBackend(value: unknown): value is StorageBackend {
  return value === 'wallet' || value === 'sdk' || value === 'independent';
}
function isOperation(value: unknown): value is StorageHealthOperation {
  return (
    value === 'open' ||
    value === 'get' ||
    value === 'query' ||
    value === 'count' ||
    value === 'cursor' ||
    value === 'mutate' ||
    value === 'transaction' ||
    value === 'sync' ||
    value === 'import' ||
    value === 'submit' ||
    value === 'validate'
  );
}

export class StorageUnavailableError extends Error {
  constructor() {
    super('StorageUnavailableError');
    this.name = 'StorageUnavailableError';
  }
}

function field(value: object, name: string): unknown {
  try {
    return Reflect.get(value, name);
  } catch {
    return undefined;
  }
}

function decode(value: unknown): StorageHealth | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const status = field(value, 'status');
  const epoch = field(value, 'epoch');
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return undefined;
  if (status === 'healthy') return { status, epoch };
  const reason = field(value, 'reason');
  const backend = field(value, 'backend');
  const operation = field(value, 'operation');
  const time = field(value, 'time');
  if (
    status !== 'unavailable' ||
    !isReason(reason) ||
    !isBackend(backend) ||
    !isOperation(operation) ||
    typeof time !== 'number' ||
    !Number.isFinite(time)
  )
    return undefined;
  return { status, epoch, reason, backend, operation, time };
}

function publishAvailability(): void {
  const current = getStorageAvailability();
  for (const listener of availabilityListeners) {
    try {
      listener(current);
    } catch {
      /* Availability observers cannot defeat the gate. */
    }
  }
}

export function getStorageAvailability(): StorageAvailability {
  return hydrated || snapshot.status === 'unavailable' ? snapshot : { status: 'pending' };
}

export function subscribeStorageAvailability(listener: (availability: StorageAvailability) => void): () => void {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
}

export function sanitizeStorageAvailability(availability: StorageAvailability): StorageAvailability {
  if (availability.status === 'pending') return { status: 'pending' };
  if (availability.status === 'healthy') return { status: 'healthy', epoch: availability.epoch };
  const { status, epoch, reason, backend, operation, time } = availability;
  return { status, epoch, reason, backend, operation, time };
}

function publish(persist: boolean): void {
  publishAvailability();
  const current = snapshot;
  if (persist && !isInOffscreenDocument()) {
    persistence = persistence.then(() => getStorageProvider().set({ [STORAGE_HEALTH_KEY]: current })).catch(() => {});
  }
  try {
    channel?.postMessage(current);
  } catch {
    /* Live transport is best effort; the latch remains. */
  }
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      /* A subscriber cannot defeat the gate. */
    }
  }
}

export function configureStorageHealthTransport(load: () => Promise<unknown>): void {
  transportLoader = load;
}

export function getStorageHealth(): StorageHealth {
  return snapshot;
}
export function subscribeStorageHealth(listener: (health: StorageHealth) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function assertStorageHealthy(expectedEpoch?: number): void {
  if (snapshot.status !== 'healthy' || (expectedEpoch !== undefined && snapshot.epoch !== expectedEpoch))
    throw new StorageUnavailableError();
}
export function adoptStorageHealth(value: unknown): boolean {
  const incoming = decode(value);
  // A healthy mirror is never permission to resume. Only explicit local validation/reset grants it.
  if (!incoming || incoming.status !== 'unavailable') return false;
  if (incoming.epoch <= snapshot.epoch) return false;
  snapshot = snapshot.status === 'unavailable' ? { ...snapshot, epoch: incoming.epoch } : incoming;
  failureRevision++;
  publish(true);
  return true;
}
export function initializeStorageHealth(): Promise<void> {
  if (initialization) return initialization;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel('miden-storage-health-v1');
      channel.onmessage = event => {
        const value: unknown = event.data;
        if (!adoptStorageHealth(value)) adoptStorageHealthRecovery(value);
      };
    } catch {
      /* Persistent hydration still protects restart. */
    }
  }
  initialization = (async () => {
    try {
      if (isInOffscreenDocument()) {
        if (!transportLoader) throw new StorageUnavailableError();
        const loaded = decode(await transportLoader());
        if (!loaded) throw new StorageUnavailableError();
        if (loaded.status === 'healthy' && snapshot.status === 'healthy' && snapshot.epoch === 0) snapshot = loaded;
        else adoptStorageHealth(loaded);
        return;
      }
      const stored: unknown = (await getStorageProvider().get([STORAGE_HEALTH_KEY]))[STORAGE_HEALTH_KEY];
      const recovered = decode(stored);
      if (recovered?.status === 'healthy' && snapshot.status === 'healthy' && snapshot.epoch === 0)
        snapshot = recovered;
      else if (stored !== undefined && !recovered)
        markStorageUnavailable('backing-store', { backend: 'independent', operation: 'open' });
      else adoptStorageHealth(stored);
    } catch (error) {
      reportStorageFailure(error, { backend: 'independent', operation: 'open' });
      // An unreadable incident mirror cannot establish permission to mutate.
      markStorageUnavailable('backing-store', { backend: 'independent', operation: 'open' });
    } finally {
      hydrated = true;
      publishAvailability();
    }
  })();
  return initialization;
}
export function flushStorageHealth(): Promise<void> {
  return persistence;
}
export function markStorageUnavailable(reason: StorageFailureReason, context: StorageFailureContext): void {
  failureRevision++;
  if (snapshot.status === 'unavailable') return;
  snapshot = {
    status: 'unavailable',
    epoch: snapshot.epoch + 1,
    reason,
    backend: context.backend,
    operation: context.operation,
    time: Date.now()
  };
  publish(true);
}

export function reportStorageFailure(error: unknown, context?: StorageFailureContext): boolean {
  if (typeof error === 'object' && error !== null && context) {
    const confirmed = confirmedStorageFailures.get(error);
    if (
      confirmed &&
      confirmed.epoch === snapshot.epoch &&
      confirmed.revision === failureRevision &&
      snapshot.status === 'unavailable' &&
      confirmed.backend === context.backend &&
      confirmed.operation === context.operation
    )
      return true;
  }
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let inspected = 0; pending.length && inspected < 24; inspected++) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    const name = field(current, 'name');
    const message = field(current, 'message');
    const excluded = typeof name === 'string' && /abort|cancel|deadline|timeout|poison|network/i.test(name);
    if (
      name === 'QuotaExceededError' ||
      (context &&
        !excluded &&
        typeof message === 'string' &&
        /\bQuotaExceededError\b|storage quota exceeded/i.test(message))
    ) {
      failureRevision++;
      markStorageUnavailable('quota', context ?? { backend: 'independent', operation: 'mutate' });
      return true;
    }
    if (
      context &&
      typeof message === 'string' &&
      !excluded &&
      (/backing[ -]?store|disk.*(?:I\/O|full|error)|database.*corrupt|indexeddb.*(?:I\/O|error)/i.test(message) ||
        ((context.backend === 'wallet' || name === 'UnknownError') && /(?:I\/O|IO) error/i.test(message)))
    ) {
      failureRevision++;
      markStorageUnavailable('backing-store', context);
      return true;
    }
    pending.push(field(current, 'cause'), field(current, 'inner'));
  }
  return false;
}

/** The authenticated offscreen recovery-read route gets only expiring constructor permission, never a health reset. */
export async function withStorageRecoveryAccess<T>(
  epoch: number,
  expiresAt: number,
  read: (capability: StorageRecoveryCapability) => Promise<T>
): Promise<T> {
  if (
    !Number.isSafeInteger(expiresAt) ||
    epoch !== snapshot.epoch ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 5000
  )
    throw new StorageUnavailableError();
  const capability: StorageRecoveryCapability = Object.freeze({ epoch, expiresAt });
  recoveryCapabilities.set(capability, failureRevision);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const result = await read(capability);
        assertStorageRecoveryAllowed(capability);
        return result;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StorageUnavailableError()), expiresAt - Date.now());
      })
    ]);
  } finally {
    clearTimeout(timer);
    recoveryCapabilities.delete(capability);
  }
}

/** The callback must perform bounded read/write/readback and continuity checks, throwing on any mismatch. */
export async function validateStorageHealth(
  validate: (capability: StorageRecoveryCapability) => Promise<void>,
  timeoutMs = 10_000
): Promise<boolean> {
  const epoch = snapshot.epoch;
  const revision = failureRevision;
  const capability: StorageRecoveryCapability = Object.freeze({
    epoch,
    expiresAt: Date.now() + Math.min(10_000, Math.max(1, timeoutMs))
  });
  recoveryCapabilities.set(capability, revision);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const checkAndReset = async (): Promise<boolean> => {
      await validate(capability);
      if (snapshot.epoch !== epoch || failureRevision !== revision) return false;
      assertStorageRecoveryAllowed(capability);
      await resetStorageHealthForLifecycle(epoch, capability);
      return true;
    };
    return await Promise.race([
      checkAndReset(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StorageUnavailableError()), Math.min(10_000, Math.max(1, timeoutMs)));
      })
    ]);
  } catch (error) {
    reportStorageFailure(error, { backend: 'wallet', operation: 'validate' });
    return false;
  } finally {
    recoveryCapabilities.delete(capability);
    clearTimeout(timer);
  }
}

/** Only a serialized, explicitly authorized reset/import or validated recovery may call this. */
export async function resetStorageHealthForLifecycle(
  expectedEpoch: number,
  capability?: StorageRecoveryCapability
): Promise<void> {
  if (snapshot.epoch !== expectedEpoch) throw new StorageUnavailableError();
  if (capability) assertStorageRecoveryAllowed(capability);
  if (isInOffscreenDocument()) throw new StorageUnavailableError();
  const revision = failureRevision;
  const healthy: StorageHealth = { status: 'healthy', epoch: expectedEpoch + 1 };
  if (!isInOffscreenDocument()) {
    await flushStorageHealth();
    await getStorageProvider().set({ [STORAGE_HEALTH_KEY]: healthy });
    if (
      snapshot.epoch !== expectedEpoch ||
      failureRevision !== revision ||
      (capability !== undefined &&
        (Date.now() >= capability.expiresAt || recoveryCapabilities.get(capability) !== revision))
    ) {
      publish(true);
      throw new StorageUnavailableError();
    }
  }
  snapshot = healthy;
  publish(false);
  try {
    channel?.postMessage({ recoveryFrom: expectedEpoch, health: healthy });
  } catch {
    /* Restart hydration retains the verified epoch. */
  }
}

export function adoptStorageHealthRecovery(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const previous = field(value, 'recoveryFrom');
  const healthy = decode(field(value, 'health'));
  if (
    !healthy ||
    healthy.status !== 'healthy' ||
    typeof previous !== 'number' ||
    healthy.epoch !== previous + 1 ||
    snapshot.epoch > previous
  )
    return false;
  if (snapshot.status === 'unavailable' && snapshot.epoch !== previous) return false;
  snapshot = healthy;
  publish(false);
  return true;
}
