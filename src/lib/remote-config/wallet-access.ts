export interface WalletAccessSnapshot {
  status: 'loading' | 'allowed' | 'restricted' | 'unavailable';
  expiresAt: number | null;
}

interface WalletAccessRuntime {
  scope(): string;
  refresh(): Promise<void>;
}

const LEASE_MS = 60_000;
const DENIED_CODE = 'WALLET_ACCESS_DENIED';
const listeners = new Set<() => void>();
let runtime: WalletAccessRuntime | undefined;
let activeScope: string | undefined;
let retiredScope: string | undefined;
let snapshot: WalletAccessSnapshot = { status: 'loading', expiresAt: null };
let grantedAt: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<void> | undefined;
let notificationPending = false;
let invalidationGeneration = 0;

export class WalletAccessDeniedError extends Error {
  readonly code = DENIED_CODE;

  constructor() {
    super('Wallet access is unavailable');
    this.name = 'WalletAccessDeniedError';
  }
}

export function isWalletAccessDeniedError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return false;
    seen.add(current);
    try {
      if (Reflect.get(current, 'code') === DENIED_CODE || Reflect.get(current, 'errorCode') === DENIED_CODE)
        return true;
      current = Reflect.get(current, 'cause');
    } catch {
      return false;
    }
  }
  return false;
}

function notify(deferred: boolean): void {
  if (deferred) {
    if (notificationPending) return;
    notificationPending = true;
    void Promise.resolve().then(() => {
      if (!notificationPending) return;
      notificationPending = false;
      listeners.forEach(listener => listener());
    });
    return;
  }
  notificationPending = false;
  listeners.forEach(listener => listener());
}

function publish(status: WalletAccessSnapshot['status'], expiresAt: number | null, deferred = false): void {
  if (snapshot.status === status && snapshot.expiresAt === expiresAt) return;
  snapshot = { status, expiresAt };
  notify(deferred);
}

function clearLease(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  grantedAt = undefined;
}

function currentScope(): string | undefined {
  try {
    return runtime?.scope();
  } catch {
    return undefined;
  }
}

function synchronize(deferred: boolean): void {
  const scope = currentScope();
  const now = performance.now();
  const expired =
    snapshot.status === 'allowed' &&
    (grantedAt === undefined || snapshot.expiresAt === null || now < grantedAt || now >= snapshot.expiresAt);
  if (scope !== activeScope || expired || runtime === undefined) {
    activeScope = scope;
    clearLease();
    publish('loading', null, deferred);
  }
}

/** Stable until a decision, scope or monotonic lease changes. Getter notifications wait until after render. */
export function getWalletAccessSnapshot(): WalletAccessSnapshot {
  synchronize(true);
  return snapshot;
}

export function subscribeWalletAccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerWalletAccessRuntime(next: WalletAccessRuntime): void {
  runtime = next;
  activeScope = currentScope();
  retiredScope = undefined;
  refreshing = undefined;
  clearLease();
  publish('loading', null);
}

/** Runtime scopes include this generation, so reset can invalidate without importing runtime dependencies. */
export function getWalletAccessGeneration(): number {
  return invalidationGeneration;
}

/** Explicit invalidation retires this request generation; its late response cannot grant access again. */
export function invalidateWalletAccess(): void {
  activeScope = currentScope();
  retiredScope = activeScope;
  invalidationGeneration += 1;
  clearLease();
  publish('loading', null);
}

export function publishWalletAccessDecision(scope: string, allowed: boolean | null): void {
  if (!runtime || scope !== currentScope() || (allowed === true && scope === retiredScope)) return;
  activeScope = scope;
  clearLease();
  if (allowed !== true) {
    publish(allowed === false ? 'restricted' : 'unavailable', null);
    return;
  }
  grantedAt = performance.now();
  const expiresAt = grantedAt + LEASE_MS;
  timer = setTimeout(() => synchronize(false), LEASE_MS);
  publish('allowed', expiresAt);
}

export function assertWalletAccessAllowed(): void {
  synchronize(false);
  if (snapshot.status !== 'allowed') throw new WalletAccessDeniedError();
}

export async function ensureWalletAccessAllowed(): Promise<void> {
  synchronize(false);
  if (snapshot.status === 'allowed') return;
  const owner = runtime;
  if (!owner) throw new WalletAccessDeniedError();
  if (!refreshing) {
    const pending = Promise.resolve()
      .then(() => owner.refresh())
      .catch(() => {
        if (runtime === owner && getWalletAccessSnapshot().status === 'loading') {
          const scope = currentScope();
          if (scope !== undefined) publishWalletAccessDecision(scope, null);
        }
      })
      .finally(() => {
        if (refreshing === pending) refreshing = undefined;
      });
    refreshing = pending;
  }
  await refreshing;
  assertWalletAccessAllowed();
}
