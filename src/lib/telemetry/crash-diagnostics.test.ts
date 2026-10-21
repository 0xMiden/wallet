import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';

import {
  PROPOSAL_GUARDS,
  PROPOSAL_STEPS,
  annotateCrash,
  snapshotCrashDiagnostics,
  withProposalStep
} from './crash-diagnostics';
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

  it('accepts every proposal step and guard, and a guard only beside its step', () => {
    for (const proposalStep of PROPOSAL_STEPS) {
      for (const proposalGuard of PROPOSAL_GUARDS) {
        const error = new Error('refused');
        annotateCrash(error, { proposalStep, proposalGuard });
        expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep, proposalGuard });
      }
    }
    const guardOnly = new Error('guard only');
    annotateCrash(guardOnly, { proposalGuard: 'hot_key_missing' });
    expect(snapshotCrashDiagnostics(guardOnly)).toEqual({});
    const unlisted = new Error('unlisted');
    annotateCrash(unlisted, { proposalStep: 'consume_build 0xabcdef', proposalGuard: 'other' });
    annotateCrash(unlisted, { proposalStep: { toString: () => 'service_load' } });
    expect(snapshotCrashDiagnostics(unlisted)).toEqual({});
  });

  it('keeps the innermost proposal step when an outer boundary names a broader one', async () => {
    const error = new Error('load failed');
    const inner = withProposalStep('service_load', () => Promise.reject(error));
    await expect(withProposalStep('service_select', () => inner)).rejects.toBe(error);
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_load' });
    annotateCrash(error, { proposalStep: 'chain_sync', proposalGuard: 'account_not_guardian', portReconnected: true });
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_load', portReconnected: true });
  });

  it('returns the operation result and rethrows a non-Error rejection untouched', async () => {
    await expect(withProposalStep('proposal_create', async () => 7)).resolves.toBe(7);
    const refusal = { status: 409 };
    await expect(withProposalStep('proposal_create', () => Promise.reject(refusal))).rejects.toBe(refusal);
  });
});
