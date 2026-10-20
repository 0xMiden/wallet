import {
  assertWalletAccessAllowed,
  ensureWalletAccessAllowed,
  getWalletAccessSnapshot,
  invalidateWalletAccess,
  isWalletAccessDeniedError,
  publishWalletAccessDecision,
  registerWalletAccessRuntime,
  subscribeWalletAccess,
  WalletAccessDeniedError
} from './wallet-access';

jest.unmock('./wallet-access');

let scope = 'testnet:13:0';
let generation = 0;
const refresh = jest.fn<Promise<void>, []>();

beforeEach(() => {
  jest.useFakeTimers();
  generation = 0;
  scope = 'testnet:13:0';
  refresh.mockReset().mockImplementation(async () => {
    scope = `testnet:13:${++generation}`;
    publishWalletAccessDecision(scope, true);
  });
  registerWalletAccessRuntime({ scope: () => scope, refresh });
});

afterEach(() => {
  invalidateWalletAccess();
  jest.restoreAllMocks();
});

it('denies before runtime registration with a fixed error code', async () => {
  let isolated!: typeof import('./wallet-access');
  jest.isolateModules(() => {
    isolated = jest.requireActual<typeof import('./wallet-access')>('./wallet-access');
  });
  expect(() => isolated.assertWalletAccessAllowed()).toThrow('Wallet access is unavailable');
  await expect(isolated.ensureWalletAccessAllowed()).rejects.toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
});

it('keeps a stable loading snapshot until a permission is published', () => {
  const loading = getWalletAccessSnapshot();
  expect(loading.status).toBe('loading');
  expect(getWalletAccessSnapshot()).toBe(loading);
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
  publishWalletAccessDecision(scope, true);
  const allowed = getWalletAccessSnapshot();
  expect(allowed.status).toBe('allowed');
  expect(getWalletAccessSnapshot()).toBe(allowed);
  expect(() => assertWalletAccessAllowed()).not.toThrow();
});

it('expires exactly after 60 seconds and notifies an active subscriber', async () => {
  const changed = jest.fn();
  const unsubscribe = subscribeWalletAccess(changed);
  publishWalletAccessDecision(scope, true);
  await jest.advanceTimersByTimeAsync(59_999);
  expect(() => assertWalletAccessAllowed()).not.toThrow();
  await jest.advanceTimersByTimeAsync(1);
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
  expect(getWalletAccessSnapshot().status).toBe('loading');
  expect(changed).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it('checks monotonic expiry even when the lease timer did not run', () => {
  publishWalletAccessDecision(scope, true);
  jest.spyOn(performance, 'now').mockReturnValue(60_001);
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
});

it('does not extend an allowed lease when the wall clock moves backwards', async () => {
  publishWalletAccessDecision(scope, true);
  jest.setSystemTime(Date.now() - 86_400_000);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
});

it.each([false, null])('denies a published %s answer', allowed => {
  publishWalletAccessDecision(scope, allowed);
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
  expect(getWalletAccessSnapshot().status).toBe(allowed === false ? 'restricted' : 'unavailable');
});

it('invalidates synchronously when the effective network or policy scope changes', () => {
  publishWalletAccessDecision(scope, true);
  scope = 'mainnet:14:1';
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
  expect(getWalletAccessSnapshot().status).toBe('loading');
  publishWalletAccessDecision('testnet:13:0', true);
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
});

it('does not restore a retired permission scope after reset', () => {
  publishWalletAccessDecision(scope, true);
  invalidateWalletAccess();
  publishWalletAccessDecision(scope, true);
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
  scope = 'testnet:13:1';
  publishWalletAccessDecision(scope, true);
  expect(() => assertWalletAccessAllowed()).not.toThrow();
});

it('refreshes expired permission once for concurrent protected callers', async () => {
  publishWalletAccessDecision(scope, true);
  await jest.advanceTimersByTimeAsync(60_000);
  let finish!: () => void;
  refresh.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = () => {
          scope = 'testnet:13:1';
          publishWalletAccessDecision(scope, true);
          resolve();
        };
      })
  );
  const first = ensureWalletAccessAllowed();
  const second = ensureWalletAccessAllowed();
  await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(1);
  finish();
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
});

it('keeps a failed refresh denied using the fixed error without leaking its upstream detail', async () => {
  refresh.mockRejectedValue(new Error('private upstream detail'));
  await expect(ensureWalletAccessAllowed()).rejects.toMatchObject({ code: 'WALLET_ACCESS_DENIED' });
  expect(getWalletAccessSnapshot().status).toBe('unavailable');
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
});

it('recognizes denied errors across a bounded cause chain and stops on cycles', () => {
  const denied = new WalletAccessDeniedError();
  expect(isWalletAccessDeniedError(denied)).toBe(true);
  expect(isWalletAccessDeniedError({ cause: { cause: { code: 'WALLET_ACCESS_DENIED' } } })).toBe(true);
  expect(isWalletAccessDeniedError({ cause: { errorCode: 'WALLET_ACCESS_DENIED' } })).toBe(true);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  expect(isWalletAccessDeniedError(cyclic)).toBe(false);
  let wrapped: unknown = denied;
  for (let i = 0; i < 12; i += 1) wrapped = { cause: wrapped };
  expect(isWalletAccessDeniedError(wrapped)).toBe(false);
  expect(isWalletAccessDeniedError(null)).toBe(false);
});
