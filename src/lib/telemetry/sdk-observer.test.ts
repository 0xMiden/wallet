import {
  __resetProveTelemetryForTest,
  beginProveAttempt,
  getProveTelemetry,
  type ProveTelemetryEntry
} from 'lib/miden/sdk/prove-telemetry';

import { createWalletSdkObserver } from './sdk-observer';

const mockIsMobile = jest.fn(() => false);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

/**
 * The shape the SDK hands an observer. Declared here rather than imported so
 * these tests can hand the observer an object the SDK's own type would not
 * permit — a `sensitive` field with a throwing getter, an operation name
 * carrying an address — which is the only way to prove the wallet never
 * reaches for either.
 */
interface Observation {
  op: string;
  outcome: 'ok' | 'error';
  durationMs: number;
}

/** A poison value that must never reach the prove ring under any mapping. */
const ADDRESS = 'mtst1qqz9p8k7v3rn2xldw4s6yc0gjhm5t8auq';
const ERROR_MESSAGE = 'proving failed for account mtst1qqz9p8k7v3rn2xldw4s6yc0gjhm5t8auq: nonce mismatch';

describe('createWalletSdkObserver', () => {
  beforeEach(() => {
    __resetProveTelemetryForTest();
    mockIsMobile.mockReturnValue(false);
    jest.restoreAllMocks();
  });

  it('attributes a prove observation to the wallet prove attempt that is open', () => {
    const attempt = beginProveAttempt();
    createWalletSdkObserver()({ op: 'proveTransaction', outcome: 'ok', durationMs: 21_000 });
    const entry = attempt.record({ path: 'local', durationMs: 25_000, fellBack: false });
    attempt.end();

    expect(getProveTelemetry()).toHaveLength(1);
    expect(entry?.proveStepMs).toBe(21_000);
    expect(entry?.proveStepFailed).toBeUndefined();
  });

  it('sums both prove steps of a delegate attempt that fell back to a local re-prove', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const observe = createWalletSdkObserver();
    const attempt = beginProveAttempt();
    observe({ op: 'proveTransaction', outcome: 'error', durationMs: 20_000 });
    observe({ op: 'proveTransaction', outcome: 'ok', durationMs: 6_000 });
    const entry = attempt.record({ path: 'local', durationMs: 27_000, fellBack: true, remoteDurationMs: 20_000 });
    attempt.end();

    expect(entry?.proveStepMs).toBe(26_000);
    // The remote prove failed, which is why there was a second one at all.
    expect(entry?.proveStepFailed).toBe(true);
  });

  it.each([
    'executeTransaction',
    'submitProvenTransaction',
    'applyTransaction',
    'syncState',
    'getAccount',
    'newWallet'
  ])('drops a %s observation, which the wallet has no mapping for', op => {
    const attempt = beginProveAttempt();
    expect(() => createWalletSdkObserver()({ op, outcome: 'ok', durationMs: 1 })).not.toThrow();
    const entry = attempt.record({ path: 'local', durationMs: 10, fellBack: false });
    attempt.end();

    expect(entry?.proveStepMs).toBeUndefined();
  });

  it('never reads the sensitive field, even when the SDK supplies one', () => {
    const observation: Observation = { op: 'proveTransaction', outcome: 'error', durationMs: 1 };
    Object.defineProperty(observation, 'sensitive', {
      enumerable: true,
      get() {
        throw new Error('the wallet must never read observation.sensitive');
      }
    });

    const attempt = beginProveAttempt();
    expect(() => createWalletSdkObserver()(observation)).not.toThrow();
    const entry = attempt.record({ path: 'local', durationMs: 5, fellBack: false });
    attempt.end();

    // Positive control: the observation was processed, so the getter really was
    // in the path an unguarded implementation would have walked.
    expect(entry?.proveStepMs).toBe(1);
  });

  it('carries no part of the operation name into the prove ring, however leak-shaped it is', () => {
    const observe = createWalletSdkObserver();
    const attempt = beginProveAttempt();
    observe({ op: ADDRESS, outcome: 'error', durationMs: 3 });
    observe({ op: ERROR_MESSAGE, outcome: 'error', durationMs: 4 });
    observe({ op: `proveTransaction ${ADDRESS}`, outcome: 'error', durationMs: 5 });
    const entry = attempt.record({ path: 'local', durationMs: 12, fellBack: false });
    attempt.end();

    const recorded = JSON.stringify(getProveTelemetry());
    expect(recorded).not.toContain(ADDRESS);
    expect(recorded).not.toContain('nonce mismatch');
    expect(recorded).not.toContain('proveTransaction');
    // None of the three mapped, so none contributed a duration either.
    expect(entry?.proveStepMs).toBeUndefined();
  });

  it('records only numbers and the ring\u2019s own closed unions, never a string from the observation', () => {
    const attempt = beginProveAttempt();
    createWalletSdkObserver()({ op: 'proveTransaction', outcome: 'error', durationMs: 9 });
    const entry = attempt.record({ path: 'local', durationMs: 12, fellBack: false });
    attempt.end();

    const stringValues = Object.entries(entry ?? {})
      .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
      .map(([key, value]) => `${key}=${value}`);
    // Both are members of unions this codebase already owned. Nothing the
    // observation carried is among them.
    expect(stringValues).toEqual(['path=local', 'platform=desktop']);
  });

  it('is stateless, so re-registering it on a second client changes nothing', () => {
    const first = createWalletSdkObserver();
    const second = createWalletSdkObserver();
    const attempt = beginProveAttempt();
    first({ op: 'proveTransaction', outcome: 'ok', durationMs: 100 });
    second({ op: 'proveTransaction', outcome: 'ok', durationMs: 200 });
    const entry: ProveTelemetryEntry | undefined = attempt.record({ path: 'local', durationMs: 400, fellBack: false });
    attempt.end();

    expect(entry?.proveStepMs).toBe(300);
  });
});

describe('createWalletSdkObserver, when the recorder it delegates to throws', () => {
  afterEach(() => {
    jest.dontMock('lib/miden/sdk/prove-telemetry');
    jest.resetModules();
  });

  it('swallows it, because an observer must never be able to fail a client operation', async () => {
    // The SDK swallows a throwing observer too. Not relying on that is the
    // point: this wallet's guarantee has to hold on its own terms.
    jest.resetModules();
    const recordSdkProveStep = jest.fn(() => {
      throw new Error('the recorder blew up');
    });
    jest.doMock('lib/miden/sdk/prove-telemetry', () => ({ recordSdkProveStep }));

    const { createWalletSdkObserver: create } = await import('./sdk-observer');
    expect(() => create()({ op: 'proveTransaction', outcome: 'ok', durationMs: 1 })).not.toThrow();
    // Positive control: the throw really did come from the path under test.
    expect(recordSdkProveStep).toHaveBeenCalledTimes(1);
  });
});
