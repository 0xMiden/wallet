import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';

import { annotateCrash, snapshotCrashDiagnostics } from './crash-diagnostics';
import { USER_ERROR_SURFACES } from './user-visible-error';

describe('source-bound crash diagnostics', () => {
  it('loads and validates user-error diagnostics without loading a reporter or crash client', () => {
    const forbiddenDependencies = ['./user-visible-error', './crash'];
    for (const dependency of forbiddenDependencies) {
      jest.doMock(dependency, () => {
        throw new Error(`diagnostics loaded forbidden runtime ${dependency}`);
      });
    }

    try {
      let snapshot: unknown;
      expect(() =>
        jest.isolateModules(() => {
          const diagnostics = jest.requireActual<typeof import('./crash-diagnostics')>('./crash-diagnostics');
          const error = new Error('failure');
          diagnostics.annotateCrash(error, {
            userErrorId: 'usdcxFaucetUnavailable',
            userErrorSurface: 'review',
            message: 'private failure text'
          });
          snapshot = diagnostics.snapshotCrashDiagnostics(error);
        })
      ).not.toThrow();
      expect(snapshot).toEqual({ userErrorId: 'usdcxFaucetUnavailable', userErrorSurface: 'review' });
    } finally {
      for (const dependency of forbiddenDependencies) jest.dontMock(dependency);
    }
  });

  it('accepts the closed user-visible error id and every display surface', () => {
    for (const userErrorSurface of USER_ERROR_SURFACES) {
      const error = new Error('failure');
      annotateCrash(error, { userErrorId: 'usdcxFaucetUnavailable', userErrorSurface });
      expect(snapshotCrashDiagnostics(error)).toEqual({ userErrorId: 'usdcxFaucetUnavailable', userErrorSurface });
    }
  });

  it('drops user-visible error text and unlisted surfaces independently', () => {
    const error = new Error('failure');
    annotateCrash(error, { userErrorId: 'Unable to read 0x12ab', userErrorSurface: 'review' });
    expect(snapshotCrashDiagnostics(error)).toEqual({ userErrorSurface: 'review' });
    const other = new Error('failure');
    annotateCrash(other, { userErrorId: 'usdcxFaucetUnavailable', userErrorSurface: 'toast' });
    expect(snapshotCrashDiagnostics(other)).toEqual({ userErrorId: 'usdcxFaucetUnavailable' });
    const invalid = new Error('failure');
    annotateCrash(invalid, { userErrorId: { toString: () => 'usdcxFaucetUnavailable' }, userErrorSurface: null });
    expect(snapshotCrashDiagnostics(invalid)).toEqual({});
  });

  it('keeps diagnostics on the exact failure rather than the latest operation', () => {
    const first = new Error('first');
    const second = new Error('second');
    annotateCrash(first, { operation: 'intercom_request', requestType: WalletMessageType.UnlockRequest });
    annotateCrash(second, { operation: 'confirm_payload', confirmationId: 'missing' });
    expect(snapshotCrashDiagnostics(first)).toEqual({ operation: 'intercom_request', requestType: 'UNLOCK_REQUEST' });
    expect(snapshotCrashDiagnostics(second)).toEqual({ operation: 'confirm_payload', confirmationId: 'missing' });
    expect(snapshotCrashDiagnostics(new Error('third'))).toEqual({});
  });

  it('accepts only authoritative request enums, not response types or payload values', () => {
    for (const requestType of [WalletMessageType.UnlockResponse, 'password=sensitive', 'UNLOCK_REQUEST_suffix']) {
      const error = new Error('failure');
      annotateCrash(error, { requestType });
      expect(snapshotCrashDiagnostics(error)).toEqual({});
    }
    const error = new Error('failure');
    annotateCrash(error, { requestType: MidenMessageType.DAppGetPayloadRequest });
    expect(snapshotCrashDiagnostics(error)).toEqual({ requestType: MidenMessageType.DAppGetPayloadRequest });
  });

  it('drops unknown fields and poisoned enum values without retaining their objects', () => {
    const error = new Error('failure');
    const poisoned = { operation: 'seed phrase', stage: 'unknown', workerMode: 'url', payload: 'secret' };
    annotateCrash(error, poisoned);
    expect(snapshotCrashDiagnostics(error)).toEqual({});
    Object.assign(error, { operation: 'intercom_request' });
    expect(snapshotCrashDiagnostics(error)).toEqual({});
    expect(() => annotateCrash(null, poisoned)).not.toThrow();
  });

  it('cannot replace the original failure when a hostile object rejects Error checks', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile object');
        }
      }
    );
    expect(() => annotateCrash(hostile, { operation: 'sdk_initialize' })).not.toThrow();
    expect(snapshotCrashDiagnostics(hostile)).toEqual({});
  });

  it('never accepts a changing accessor after the allowlist check', () => {
    const error = new Error('failure');
    let reads = 0;
    const poisoned = {
      get operation() {
        return reads++ === 0 ? 'intercom_request' : 'secret phrase';
      }
    };
    annotateCrash(error, poisoned);
    expect(snapshotCrashDiagnostics(error)).toEqual({ operation: 'intercom_request' });
  });

  it("keeps a startup trap's memory evidence only as its fixed values", () => {
    const error = new Error('unreachable');
    annotateCrash(error, { sharedMemoryProbe: 'refused', extensionViews: '2-3' });
    expect(snapshotCrashDiagnostics(error)).toEqual({ sharedMemoryProbe: 'refused', extensionViews: '2-3' });
    for (const [sharedMemoryProbe, extensionViews] of [
      [5, 5],
      ['5', '5'],
      ['RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded', '4 +'],
      ['REFUSED', 'one']
    ]) {
      const dropped = new Error('unreachable');
      annotateCrash(dropped, { sharedMemoryProbe, extensionViews });
      expect(snapshotCrashDiagnostics(dropped)).toEqual({});
    }
  });

  it.each(['open', 'answered', 'window_closed', 'expired', 'payload_failed', 'unknown'])(
    "reads the background's confirmation_%s code back to its state",
    state => {
      const error = new Error('Not Found');
      annotateCrash(error, { confirmationHandler: `confirmation_${state}`, portReconnected: true });
      expect(snapshotCrashDiagnostics(error)).toEqual({ confirmationHandler: state, portReconnected: true });
    }
  );

  it('drops a confirmation code or a reconnect flag that is not exactly one of its values', () => {
    for (const confirmationHandler of [
      'expired',
      'confirmation_unknown 0xab',
      `0x${'ab'.repeat(32)}`,
      'confirmation_V1StGXR8_Z5jdHi6B-myT',
      'confirmation_',
      7
    ]) {
      const error = new Error('Not Found');
      annotateCrash(error, { confirmationHandler, portReconnected: 'true' });
      annotateCrash(error, { portReconnected: 1 });
      expect(snapshotCrashDiagnostics(error)).toEqual({});
    }
    const error = new Error('Not Found');
    annotateCrash(error, { portReconnected: false });
    expect(snapshotCrashDiagnostics(error)).toEqual({ portReconnected: false });
  });

  it('returns detached snapshots and preserves annotations across wrappers', () => {
    const cause = new Error('cause');
    annotateCrash(cause, { operation: 'sdk_initialize', stage: 'client_create', workerMode: 'disabled' });
    const outer = new Error('outer', { cause });
    const snapshot = snapshotCrashDiagnostics(outer);
    expect(snapshot).toEqual({ operation: 'sdk_initialize', stage: 'client_create', workerMode: 'disabled' });
    snapshot.stage = 'mock_create';
    expect(snapshotCrashDiagnostics(outer).stage).toBe('client_create');
    Object.defineProperty(cause, 'cause', { value: outer });
    expect(snapshotCrashDiagnostics(outer).stage).toBe('client_create');
  });
});

const nativeGroup = {
  reownNativeOrigin: 'wallet_error',
  reownWalletResponseCode: 'internal_error',
  reownRequestAge: '120_to_300s',
  reownPublished: 'confirmed',
  reownBackgrounded: 'yes'
};

it('validatesTheWholeNativeGroupOnEveryBoundary', () => {
  const error = new Error('native failure');
  annotateCrash(error, { ...nativeGroup, payload: 'secret', code: -32603 });
  expect(snapshotCrashDiagnostics(error)).toEqual(nativeGroup);
  const detached = snapshotCrashDiagnostics(error);
  detached.reownPublished = 'unobserved';
  expect(snapshotCrashDiagnostics(error)).toEqual(nativeGroup);
  for (const key of ['reownNativeOrigin', 'reownRequestAge', 'reownPublished']) {
    for (const value of [undefined, 'unlisted', 42]) {
      const rejected = new Error('invalid');
      annotateCrash(rejected, { ...nativeGroup, [key]: value });
      expect(snapshotCrashDiagnostics(rejected)).toEqual({});
    }
  }
  for (const reownWalletResponseCode of [undefined, 'unlisted', -32603]) {
    const fallback = new Error('wallet');
    annotateCrash(fallback, { ...nativeGroup, reownWalletResponseCode, reownBackgrounded: 'unknown' });
    expect(snapshotCrashDiagnostics(fallback)).toEqual({
      reownNativeOrigin: 'wallet_error',
      reownWalletResponseCode: 'other',
      reownRequestAge: '120_to_300s',
      reownPublished: 'confirmed'
    });
  }
  const nonWallet = new Error('publisher');
  annotateCrash(nonWallet, { ...nativeGroup, reownNativeOrigin: 'publish_error' });
  expect(snapshotCrashDiagnostics(nonWallet)).toEqual({
    reownNativeOrigin: 'publish_error',
    reownRequestAge: '120_to_300s',
    reownPublished: 'confirmed',
    reownBackgrounded: 'yes'
  });
  const reads = new Map<string, number>();
  const changing: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nativeGroup))
    Object.defineProperty(changing, key, {
      get() {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        return count === 1 ? value : 'secret';
      }
    });
  const changingError = new Error('changing');
  annotateCrash(changingError, changing);
  expect(snapshotCrashDiagnostics(changingError)).toEqual(nativeGroup);
  expect([...reads.values()]).toEqual([1, 1, 1, 1, 1]);
});

it('reannotationNeverMixesNativeGroups', () => {
  const error = new Error('native failure');
  annotateCrash(error, { ...nativeGroup, operation: 'sdk_initialize', workerMode: 'enabled' });
  const publicationGroup = {
    reownNativeOrigin: 'publish_error',
    reownRequestAge: 'under_30s',
    reownPublished: 'unobserved'
  };
  annotateCrash(error, { ...publicationGroup, stage: 'client_create' });
  expect(snapshotCrashDiagnostics(error)).toEqual({
    ...publicationGroup,
    operation: 'sdk_initialize',
    workerMode: 'enabled',
    stage: 'client_create'
  });
  annotateCrash(error, { reownPublished: 'confirmed' });
  expect(snapshotCrashDiagnostics(error)).toEqual({
    operation: 'sdk_initialize',
    workerMode: 'enabled',
    stage: 'client_create'
  });
  const inner = new Error('inner');
  annotateCrash(inner, nativeGroup);
  const outer = new Error('outer', { cause: inner });
  annotateCrash(outer, publicationGroup);
  expect(snapshotCrashDiagnostics(outer)).toEqual(publicationGroup);
  const partial = new Error('partial', { cause: inner });
  annotateCrash(partial, { reownPublished: 'unobserved' });
  expect(snapshotCrashDiagnostics(partial)).toEqual(nativeGroup);
  const unmarked = new Error('unmarked');
  annotateCrash(unmarked, { reownPublished: 'confirmed' });
  expect(snapshotCrashDiagnostics(unmarked)).toEqual({});
  Object.defineProperty(inner, 'cause', {
    get() {
      throw new Error('hostile');
    }
  });
  expect(snapshotCrashDiagnostics(outer)).toEqual(publicationGroup);
});
