/**
 * Issue #775 — the two legitimately unbounded waits inside a WASM lock hold
 * must pause the lock watchdog: a keystore sign round-trip (blocks on user
 * authentication) and a local prove attempt (the fallback when delegated
 * proving is down). The delegated prove attempt must NOT pause — it has its
 * own ceiling and a wedged delegate should be evicted.
 *
 * Every import is dynamic and per-test: the interface and the lock module must
 * come from the same fresh jest module registry, or the test would assert on a
 * different mutex than the one the interface pauses.
 */

/** The keystore `sign` shape `MidenClientInterface.create` wires into the SDK. */
type WiredSign = (publicKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array>;

/**
 * Attach a rejection expectation NOW — so the eviction's rejection always has
 * a handler — while letting the test drive timers before awaiting the outcome.
 */
function expectRejection(promise: Promise<unknown>, match: Record<string, unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject(match);
}

/**
 * The liveness `proveWithFallback` requires. A real caller passes its client's
 * shared record; a live one is what makes the local-prove pause apply, which is
 * what these tests are about (a disposed one is the corpse case, covered by the
 * lock module's own suite).
 */
const live = { disposed: false };

describe('miden-client-interface watchdog pauses', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.resetModules();
  });

  const installSdkMocks = (createMock: jest.Mock) => {
    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      MidenClient: { create: createMock, createMock: jest.fn() },
      NoteFile: { deserialize: jest.fn(() => ({})) },
      AccountFile: { deserialize: jest.fn(() => ({})) },
      NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
      NoteType: { Private: 'Private', Public: 'Public' },
      TransactionRequest: { deserialize: jest.fn(() => ({})) },
      TransactionProver: {
        newRemoteProver: jest.fn(() => 'remote'),
        newLocalProver: jest.fn(() => 'local'),
        newCallbackProver: jest.fn(() => 'callback')
      },
      getWasmOrThrow: jest.fn(async () => ({})),
      WasmWebClient: { createClient: jest.fn() },
      exportStore: jest.fn(),
      importStore: jest.fn()
    }));
    jest.doMock('lib/miden-chain/effective-endpoints', () => ({
      getEffectiveNetworkName: () => 'localnet',
      getEffectiveRpcUrl: () => 'rpc-local',
      getEffectiveProverUrl: () => undefined,
      getEffectiveNoteTransportUrl: () => undefined
    }));
    jest.doMock('./constants', () => ({ NoteExportType: {} }));
    jest.doMock('./helpers', () => ({
      getBech32AddressFromAccountId: (id: unknown) => String(id),
      walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
      buildSendTransactionRequest: jest.fn()
    }));
    jest.doMock('../db/types', () => ({
      ConsumeTransaction: class {},
      SendTransaction: class {}
    }));
    jest.doMock('screens/onboarding/types', () => ({
      WalletType: { OnChain: 'on-chain', OffChain: 'off-chain' }
    }));
    jest.doMock('lib/miden/activity/connectivity-state', () => ({
      markConnectivityIssue: jest.fn(),
      clearConnectivityIssue: jest.fn()
    }));
  };

  it('pauses the watchdog for the duration of a keystore sign round-trip', async () => {
    const fakeClient = { terminate: jest.fn() };
    // Typed parameter so the assertion below can reach the wired keystore
    // callback without a cast — a bare `jest.fn(async () => …)` records calls as
    // an empty tuple, so `mock.calls[0][0]` does not type-check.
    const createMock = jest.fn(async (_options?: { keystore?: { sign?: WiredSign } }) => fakeClient);
    installSdkMocks(createMock);
    const { MidenClientInterface } = await import('./miden-client-interface');
    const { withWasmClientLock, isWasmClientBusy } = await import('./miden-client');

    let releaseSign!: () => void;
    const signGate = new Promise<void>(resolve => {
      releaseSign = resolve;
    });
    const rawSign = jest.fn(() => signGate.then(() => new Uint8Array([1])));
    await MidenClientInterface.create({ signCallback: rawSign });
    const wiredSign = createMock.mock.calls[0]?.[0]?.keystore?.sign;
    if (!wiredSign) throw new Error('create() was not called with a wired keystore sign callback');

    const op = withWasmClientLock(async () => {
      await wiredSign(new Uint8Array([2]), new Uint8Array([3]));
      await new Promise<never>(() => {});
    });
    const opRejects = expectRejection(op, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    // A sign can block indefinitely on the user (Face ID, an unlock prompt) —
    // far past the ceiling the holder must survive.
    await jest.advanceTimersByTimeAsync(600_000);
    expect(isWasmClientBusy()).toBe(true);
    expect(rawSign).toHaveBeenCalledTimes(1);

    releaseSign();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await opRejects;
  });

  it('pauses the watchdog during a local prove attempt', async () => {
    installSdkMocks(jest.fn());
    const { proveWithFallback } = await import('./miden-client-interface');
    const { withWasmClientLock, isWasmClientBusy } = await import('./miden-client');

    let releaseProve!: () => void;
    const proveGate = new Promise<void>(resolve => {
      releaseProve = resolve;
    });
    const seenProvers: unknown[] = [];

    const op = withWasmClientLock(async () => {
      await proveWithFallback(
        async (prover, attempt) => {
          seenProvers.push(prover);
          // The callback brackets its own prove — see `ProveAttempt`. The pause is
          // deliberately NOT applied to the whole callback: that would disable the
          // watchdog across execute → prove → submit → apply.
          await attempt.pauseWatchdogForLocalProve(() => proveGate);
          return 'proved';
        },
        false,
        live
      );
      await new Promise<never>(() => {});
    });
    const opRejects = expectRejection(op, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    // Local proving is deliberately unbounded — capping it would leave nothing
    // to fall back to when delegated proving is down.
    await jest.advanceTimersByTimeAsync(600_000);
    expect(isWasmClientBusy()).toBe(true);
    expect(seenProvers).toEqual(['local']);

    releaseProve();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await opRejects;
  });

  it('pauses the watchdog during the local FALLBACK prove after a delegated failure', async () => {
    installSdkMocks(jest.fn());
    const { proveWithFallback } = await import('./miden-client-interface');
    const { withWasmClientLock, isWasmClientBusy } = await import('./miden-client');

    let releaseProve!: () => void;
    const proveGate = new Promise<void>(resolve => {
      releaseProve = resolve;
    });
    const seenProvers: unknown[] = [];

    const op = withWasmClientLock(async () => {
      await proveWithFallback(
        async (prover, attempt) => {
          seenProvers.push(prover);
          if (prover === undefined) throw new Error('remote prover unavailable');
          await attempt.pauseWatchdogForLocalProve(() => proveGate);
          return 'proved';
        },
        true,
        live
      );
      await new Promise<never>(() => {});
    });
    const opRejects = expectRejection(op, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    // This is the case the pause exists for: the delegated prover is DOWN and
    // the local re-prove really is unbounded.
    await jest.advanceTimersByTimeAsync(600_000);
    expect(isWasmClientBusy()).toBe(true);
    expect(seenProvers).toEqual([undefined, 'local']);

    releaseProve();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await opRejects;
  });

  it('leaves the rest of a local-prover write ON the clock — the pause covers the prove, not the callback', async () => {
    // The pause used to wrap the whole `proveWithFallback` callback, which for a
    // send is execute → prove → submit → apply. That disabled the watchdog
    // across the entire write on the default local path — precisely the
    // operation issue #775 wedges. The callback must therefore keep being
    // watched everywhere outside the prove it brackets.
    installSdkMocks(jest.fn());
    const { proveWithFallback } = await import('./miden-client-interface');
    const { withWasmClientLock, isWasmClientBusy } = await import('./miden-client');

    const op = withWasmClientLock(async () => {
      await proveWithFallback(
        async (_prover, attempt) => {
          await attempt.pauseWatchdogForLocalProve(async () => 'proved');
          // Stands in for the submit/apply tail, which is not unbounded and so
          // must not be shielded.
          await new Promise<never>(() => {});
        },
        false,
        live
      );
    });
    const opRejects = expectRejection(op, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await opRejects;
  });

  it('does not pause the watchdog for a delegated prove attempt', async () => {
    installSdkMocks(jest.fn());
    const { proveWithFallback } = await import('./miden-client-interface');
    const { withWasmClientLock, isWasmClientBusy } = await import('./miden-client');

    const op = withWasmClientLock(async () => {
      await proveWithFallback(async () => new Promise<never>(() => {}), true, live);
    });
    const opRejects = expectRejection(op, { name: 'WasmClientPoisonedError', reason: 'watchdog' });

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(isWasmClientBusy()).toBe(false);
    await opRejects;
  });
});
