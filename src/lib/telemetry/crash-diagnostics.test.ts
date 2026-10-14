import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';

import { annotateCrash, snapshotCrashDiagnostics } from './crash-diagnostics';

describe('source-bound crash diagnostics', () => {
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
