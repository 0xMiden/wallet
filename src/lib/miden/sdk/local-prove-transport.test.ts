import {
  getLocalProveTransport,
  installLocalProveTransport,
  type LocalProveOptions,
  type LocalProveRequest,
  type LocalProveTransport,
  ProveWorkerError,
  proveInWorker,
  proveWorkerErrorDetail
} from './local-prove-transport';
import { withWasmClientLock } from './miden-client';
import { beginProveAttempt } from './prove-telemetry';
import { WasmClientPoisonedError } from './wasm-client-poison';

const mockDeserializeProof = jest.fn((bytes: Uint8Array) => ({ proofBytes: Array.from(bytes) }));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  ProvenTransaction: { deserialize: (bytes: Uint8Array) => mockDeserializeProof(bytes) }
}));

const fakeResult = { serialize: () => new Uint8Array([7, 8, 9]) };

function fakeTransport(
  prove: (
    request: LocalProveRequest,
    options?: LocalProveOptions
  ) => Promise<{ proven: Uint8Array; durationMs: number }>
) {
  const transport = { prove: jest.fn(prove), prewarm: jest.fn() };
  installLocalProveTransport(transport);
  return transport;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  installLocalProveTransport(null);
  jest.useRealTimers();
  jest.restoreAllMocks();
  mockDeserializeProof.mockClear();
});

describe('ProveWorkerError', () => {
  it('carries a closed message, its kind, and the worker text on detail only', () => {
    const error = new ProveWorkerError('crashed', 'RuntimeError: unreachable');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProveWorkerError');
    expect(error.message).toBe('Local prove failed in the prove worker (crashed)');
    expect(error.kind).toBe('crashed');
    expect(error.detail).toBe('RuntimeError: unreachable');
  });
});

describe('proveWorkerErrorDetail', () => {
  it('reads a ProveWorkerError’s detail, flattened to one line', () => {
    const error = new ProveWorkerError('crashed', 'line one\nline two');
    expect(proveWorkerErrorDetail(error)).toBe('line one line two');
  });

  it('is undefined for anything that is not a ProveWorkerError, or with no detail set', () => {
    expect(proveWorkerErrorDetail(new Error('plain'))).toBeUndefined();
    expect(proveWorkerErrorDetail(new ProveWorkerError('crashed'))).toBeUndefined();
  });
});

describe('the realm transport slot', () => {
  it('is empty until a realm installs one, and can be cleared again', () => {
    expect(getLocalProveTransport()).toBeNull();
    const transport: LocalProveTransport = { prove: jest.fn(), prewarm: jest.fn() };
    installLocalProveTransport(transport);
    expect(getLocalProveTransport()).toBe(transport);
    installLocalProveTransport(null);
    expect(getLocalProveTransport()).toBeNull();
  });
});

describe('proveInWorker', () => {
  it('throws when no transport is installed', async () => {
    await withWasmClientLock(async hold => {
      await expect(proveInWorker(fakeResult, hold)).rejects.toThrow('no local prove transport');
    });
  });

  it('proves the serialized result under the hold, with the hold eviction as the cancel', async () => {
    const transport = fakeTransport(async () => ({ proven: new Uint8Array([1, 2]), durationMs: 5 }));
    const proof = await withWasmClientLock(async hold => {
      const proven = await proveInWorker(fakeResult, hold);
      expect(transport.prove).toHaveBeenCalledWith(
        { txResult: new Uint8Array([7, 8, 9]), proverDescriptor: 'local' },
        { cancel: hold.aborted }
      );
      return proven;
    });
    expect(mockDeserializeProof).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    expect(proof).toEqual({ proofBytes: [1, 2] });
  });

  it('refuses before proving when the hold is no longer current', async () => {
    const transport = fakeTransport(async () => ({ proven: new Uint8Array([1]), durationMs: 1 }));
    const stale = await withWasmClientLock(async hold => hold);
    await expect(proveInWorker(fakeResult, stale)).rejects.toBeInstanceOf(WasmClientPoisonedError);
    expect(transport.prove).not.toHaveBeenCalled();
  });

  it('relaxes the watchdog for the prove, so a 10-minute prove is not evicted', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    fakeTransport(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ proven: new Uint8Array([1]), durationMs: 600_000 });
        })
    );
    const writing = withWasmClientLock(async hold => proveInWorker(fakeResult, hold));
    const settled = writing.then(
      () => 'proved',
      (error: unknown) => (error instanceof Error ? error.name : 'unknown')
    );
    await jest.advanceTimersByTimeAsync(600_000);
    finish();
    expect(await settled).toBe('proved');
  });

  it('refuses to hand back a proof when the hold moved on during the prove', async () => {
    let finish!: () => void;
    fakeTransport(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ proven: new Uint8Array([1]), durationMs: 1 });
        })
    );
    let inner: Promise<unknown> | undefined;
    const writing = withWasmClientLock(async hold => {
      inner = proveInWorker(fakeResult, hold);
      return inner;
    });
    const writingSettled = writing.catch(() => undefined);
    await Promise.resolve();
    // A trap anywhere in the realm evicts the current holder at once (#775).
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
    await writingSettled;
    finish();
    await expect(inner).rejects.toBeInstanceOf(WasmClientPoisonedError);
    expect(mockDeserializeProof).not.toHaveBeenCalled();
  });

  it('feeds the worker-measured duration to the open prove attempt, and a failure too', async () => {
    fakeTransport(async () => ({ proven: new Uint8Array([1]), durationMs: 4321 }));
    const ok = beginProveAttempt();
    await withWasmClientLock(async hold => proveInWorker(fakeResult, hold));
    expect(ok.record({ path: 'local', durationMs: 5000, fellBack: false })).toMatchObject({ proveStepMs: 4321 });

    fakeTransport(async () => {
      throw new ProveWorkerError('crashed');
    });
    const failed = beginProveAttempt();
    await expect(withWasmClientLock(async hold => proveInWorker(fakeResult, hold))).rejects.toBeInstanceOf(
      ProveWorkerError
    );
    expect(failed.record({ path: 'local', durationMs: 1, fellBack: false })).toMatchObject({ proveStepFailed: true });
  });
});

describe('proveInWorker E2E window markers', () => {
  const realFlag = process.env.MIDEN_E2E_TEST;
  afterEach(() => {
    process.env.MIDEN_E2E_TEST = realFlag;
  });

  it('opens the local-prove window before the prove and closes it after, even on failure', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const trail: string[] = [];
    let isolated: typeof import('./local-prove-transport') | undefined;
    let lock: typeof import('./miden-client') | undefined;
    jest.isolateModules(() => {
      jest.doMock('./prove-telemetry', () => ({
        ...jest.requireActual('./prove-telemetry'),
        recordProveMarker: (line: string) => trail.push(line)
      }));
      isolated = jest.requireActual<typeof import('./local-prove-transport')>('./local-prove-transport');
      lock = jest.requireActual<typeof import('./miden-client')>('./miden-client');
    });
    if (!isolated || !lock) throw new Error('the isolated modules did not load');
    const { installLocalProveTransport: install, proveInWorker: prove } = isolated;
    install({
      prove: async () => {
        trail.push('prove');
        throw new Error('worker gone');
      },
      prewarm: () => {}
    });

    await expect(lock.withWasmClientLock(async hold => prove(fakeResult, hold))).rejects.toThrow('worker gone');
    expect(trail).toEqual([
      '[prove-timing] local-prove-window open',
      'prove',
      '[prove-timing] local-prove-window close'
    ]);
  });
});
