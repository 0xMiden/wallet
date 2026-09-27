/**
 * #945: with a local prove transport installed (only the offscreen document installs
 * one), every staged write's LOCAL attempt proves in the transport and submits the
 * proof with `submitProven`; its delegated attempt keeps the in-realm path. Every
 * in-realm prove path of the fake SDK throws on a local prover, so a local attempt
 * that proved in-realm fails with 'in-realm prove reached'.
 *
 * Imports are dynamic and per test so the interface, the lock and the transport slot
 * all come from one fresh module registry.
 */
import { SendTransaction } from '../db/types';
import { NoteTypeEnum } from '../types';
import type { LocalProveOptions, LocalProveRequest } from './local-prove-transport';

const IN_REALM = 'in-realm prove reached';

type ProveOptions = { prover?: unknown } | undefined;

function buildHarness() {
  const order: string[] = [];
  const result = { serialize: jest.fn(() => new Uint8Array([7, 7])) };
  const delegated = { fail: false };
  const executeRequest = jest.fn(async (_account: string, _request: unknown) => ({
    result,
    prove: jest.fn(async (options: ProveOptions) => {
      if (options?.prover === 'local') throw new Error(IN_REALM);
      if (delegated.fail) throw new Error('remote prover unavailable');
      order.push('delegated prove');
      return {
        submit: jest.fn(async () => {
          order.push('delegated submit');
          return { apply: jest.fn(async () => order.push('apply')) };
        })
      };
    })
  }));
  const submitProven = jest.fn(async (_proof: unknown, _result: unknown) => {
    order.push('submitProven');
    return { apply: jest.fn(async () => order.push('apply')) };
  });
  const allInOne = (label: string) =>
    jest.fn(async (...args: unknown[]) => {
      const options = args.find(
        (arg): arg is { prover?: unknown } => typeof arg === 'object' && arg !== null && 'prover' in arg
      );
      if (options?.prover === 'local') throw new Error(IN_REALM);
      if (delegated.fail) throw new Error('remote prover unavailable');
      order.push(label);
      return { txId: 'tx', result };
    });
  const inner = {
    getAccount: jest.fn(async () => ({ vault: jest.fn() })),
    getInputNote: jest.fn(
      async (id: string): Promise<{ toNote: () => { note: string } } | undefined> => ({ toNote: () => ({ note: id }) })
    ),
    newConsumeTransactionRequest: jest.fn(async (_notes: unknown[], _account: unknown) => ({
      serialize: () => new Uint8Array([3, 3])
    })),
    newPswapCreateTransactionRequest: jest.fn(async () => ({ reference: true }))
  };
  const fakeClient = {
    transactions: {
      executeRequest,
      submitProven,
      consume: allInOne('delegated consume'),
      submit: allInOne('delegated swap submit')
    },
    accounts: { get: jest.fn(async () => ({ account: true })) },
    sync: jest.fn(async () => ({ blockNum: () => 1 })),
    _withInnerWebClient: jest.fn(async (fn: (client: typeof inner) => Promise<unknown>) => fn(inner)),
    terminate: jest.fn()
  };
  let proveImpl = async (_request: LocalProveRequest, _options?: LocalProveOptions) => {
    order.push('worker prove');
    return { proven: new Uint8Array([5, 5]), durationMs: 10 };
  };
  const transport = {
    prove: jest.fn((request: LocalProveRequest, options?: LocalProveOptions) => proveImpl(request, options)),
    prewarm: jest.fn(() => order.push('prewarm'))
  };
  return {
    order,
    result,
    delegated,
    executeRequest,
    submitProven,
    fakeClient,
    inner,
    transport,
    setWorkerProve(impl: typeof proveImpl) {
      proveImpl = impl;
    }
  };
}

type Harness = ReturnType<typeof buildHarness>;

function installMocks(harness: Harness) {
  jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
    MidenClient: { create: jest.fn(async () => harness.fakeClient) },
    NoteFile: { deserialize: jest.fn() },
    AccountFile: { deserialize: jest.fn() },
    NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
    NoteType: { Private: 'Private', Public: 'Public' },
    TransactionRequest: { deserialize: jest.fn((bytes: Uint8Array) => ({ requestBytes: Array.from(bytes) })) },
    TransactionProver: {
      newRemoteProver: jest.fn(() => 'remote'),
      newLocalProver: jest.fn(() => 'local'),
      newCallbackProver: jest.fn(() => 'callback')
    },
    ProvenTransaction: { deserialize: jest.fn((bytes: Uint8Array) => ({ proofBytes: Array.from(bytes) })) },
    getWasmOrThrow: jest.fn(async () => ({
      AccountId: { fromHex: jest.fn((id: string) => id), fromBech32: jest.fn((id: string) => id) },
      NoteType: { Public: 'public', Private: 'private' }
    })),
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
  jest.doMock('./helpers', () => ({
    getBech32AddressFromAccountId: (id: unknown) => String(id),
    walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
    accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
    canonicalWalletAccountId: (id: string) => `sdk-${id}`,
    buildSendTransactionRequest: jest.fn(() => ({ serialize: () => new Uint8Array([1]) })),
    buildPswapCreateRequest: jest.fn(() => ({ pswapRequest: true }))
  }));
  jest.doMock('lib/miden/activity/connectivity-state', () => ({
    markConnectivityIssue: jest.fn(),
    clearConnectivityIssue: jest.fn()
  }));
}

async function load(harness: Harness, withTransport = true) {
  installMocks(harness);
  const { MidenClientInterface, proveWithFallback } = await import('./miden-client-interface');
  const { installLocalProveTransport } = await import('./local-prove-transport');
  const { withWasmClientLock } = await import('./miden-client');
  const { WasmClientPoisonedError } = await import('./wasm-client-poison');
  if (withTransport) installLocalProveTransport(harness.transport);
  const client = await MidenClientInterface.create();
  return { client, proveWithFallback, withWasmClientLock, WasmClientPoisonedError };
}

const sendTx = (delegateTransaction: boolean) =>
  new SendTransaction('acct', 5n, 'recipient', 'faucet', NoteTypeEnum.Public, undefined, delegateTransaction);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.resetModules();
});

function expectWorkerProved(harness: Harness) {
  expect(harness.transport.prove).toHaveBeenCalledTimes(1);
  expect(harness.transport.prove.mock.calls[0]?.[0]).toEqual({
    txResult: new Uint8Array([7, 7]),
    proverDescriptor: 'local'
  });
  expect(harness.submitProven).toHaveBeenCalledWith({ proofBytes: [5, 5] }, harness.result);
}

describe('send (site 5)', () => {
  it('a local attempt proves in the worker, then submits the proof and applies it', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    const stages: string[] = [];
    const returned = await withWasmClientLock(async () =>
      client.sendTransaction(sendTx(false), stage => void stages.push(stage))
    );
    expectWorkerProved(harness);
    expect(returned).toBe(harness.result);
    expect(harness.order).toEqual(['prewarm', 'worker prove', 'submitProven', 'apply']);
    expect(stages).toEqual(['executing', 'proving', 'submitting']);
  });

  it('a delegated attempt that fails before submit re-proves in the worker, without a prewarm', async () => {
    const harness = buildHarness();
    harness.delegated.fail = true;
    const { client, withWasmClientLock } = await load(harness);
    await withWasmClientLock(async () => client.sendTransaction(sendTx(true)));
    expectWorkerProved(harness);
    expect(harness.transport.prewarm).not.toHaveBeenCalled();
    expect(harness.executeRequest).toHaveBeenCalledTimes(2);
  });

  it('a delegated attempt that succeeds never touches the worker', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    await withWasmClientLock(async () => client.sendTransaction(sendTx(true)));
    expect(harness.transport.prove).not.toHaveBeenCalled();
    expect(harness.transport.prewarm).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['delegated prove', 'delegated submit', 'apply']);
  });

  it('an eviction during the worker prove stops the send before submit', async () => {
    const harness = buildHarness();
    let finish!: () => void;
    harness.setWorkerProve(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ proven: new Uint8Array([5]), durationMs: 1 });
        })
    );
    const { client, withWasmClientLock } = await load(harness);
    const sending = withWasmClientLock(async () => client.sendTransaction(sendTx(false))).catch(
      (error: unknown) => error
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.transport.prove).toHaveBeenCalledTimes(1);
    // A trap anywhere in the realm evicts the current holder at once (#775).
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
    await sending;
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.submitProven).not.toHaveBeenCalled();
  });

  it('a worker failure fails the send before submit', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    const { ProveWorkerError } = await import('./local-prove-transport');
    harness.setWorkerProve(async () => {
      throw new ProveWorkerError('crashed', 'boom');
    });
    await expect(withWasmClientLock(async () => client.sendTransaction(sendTx(false)))).rejects.toBeInstanceOf(
      ProveWorkerError
    );
    expect(harness.submitProven).not.toHaveBeenCalled();
  });
});

describe('newTransaction (site 6)', () => {
  it('a local attempt proves in the worker, then submits the proof and applies it', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    const returned = await withWasmClientLock(async () => client.newTransaction('acct', new Uint8Array([4]), false));
    expectWorkerProved(harness);
    expect(returned).toBe(harness.result);
    expect(harness.order).toEqual(['prewarm', 'worker prove', 'submitProven', 'apply']);
  });

  it('a delegated attempt that fails before submit re-proves in the worker', async () => {
    const harness = buildHarness();
    harness.delegated.fail = true;
    const { client, withWasmClientLock } = await load(harness);
    await withWasmClientLock(async () => client.newTransaction('acct', new Uint8Array([4]), true));
    expectWorkerProved(harness);
    expect(harness.executeRequest).toHaveBeenCalledTimes(2);
  });

  it('a worker failure fails the write before submit', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    harness.setWorkerProve(async () => {
      throw new Error('worker gone');
    });
    await expect(
      withWasmClientLock(async () => client.newTransaction('acct', new Uint8Array([4]), false))
    ).rejects.toThrow('worker gone');
    expect(harness.submitProven).not.toHaveBeenCalled();
  });
});

describe('ProveAttempt worker members', () => {
  it('refuses a worker prove for a disposed client, without calling the transport', async () => {
    const harness = buildHarness();
    const { proveWithFallback, withWasmClientLock, WasmClientPoisonedError } = await load(harness);
    const attempted = withWasmClientLock(async () =>
      proveWithFallback(async (_prover, attempt) => attempt.proveInWorker(harness.result), false, { disposed: true })
    );
    await expect(attempted).rejects.toBeInstanceOf(WasmClientPoisonedError);
    expect(harness.transport.prove).not.toHaveBeenCalled();
  });

  it('refuses a worker prove from a write that holds no lock', async () => {
    const harness = buildHarness();
    const { proveWithFallback, WasmClientPoisonedError } = await load(harness);
    const attempted = proveWithFallback(async (_prover, attempt) => attempt.proveInWorker(harness.result), false, {
      disposed: false
    });
    await expect(attempted).rejects.toBeInstanceOf(WasmClientPoisonedError);
    expect(harness.transport.prove).not.toHaveBeenCalled();
  });

  it('says a delegated attempt, or a realm with no transport, does not prove in the worker', async () => {
    const harness = buildHarness();
    const { proveWithFallback } = await load(harness, false);
    const seen: boolean[] = [];
    await proveWithFallback(
      async (_prover, attempt) => {
        seen.push(attempt.provesInWorker());
        return null;
      },
      false,
      { disposed: false }
    );
    const { installLocalProveTransport } = await import('./local-prove-transport');
    installLocalProveTransport(harness.transport);
    await proveWithFallback(
      async (_prover, attempt) => {
        seen.push(attempt.provesInWorker());
        return null;
      },
      true,
      { disposed: false }
    );
    expect(seen).toEqual([false, false]);
  });
});

describe('local-prove window markers without a transport', () => {
  const realFlag = process.env.MIDEN_E2E_TEST;
  afterEach(() => {
    process.env.MIDEN_E2E_TEST = realFlag;
  });

  it('brackets an in-realm local prove with the window markers the E2E gap check reads', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const trail: string[] = [];
    jest.doMock('./prove-telemetry', () => ({
      ...jest.requireActual('./prove-telemetry'),
      recordProveMarker: (line: string) => trail.push(line)
    }));
    const harness = buildHarness();
    const { proveWithFallback, withWasmClientLock } = await load(harness, false);
    await withWasmClientLock(async () =>
      proveWithFallback(
        async (_prover, attempt) =>
          attempt.pauseWatchdogForLocalProve(async () => {
            trail.push('in-realm prove');
          }),
        false,
        { disposed: false }
      )
    );
    const bracket = trail.filter(line => line.includes('local-prove-window') || line === 'in-realm prove');
    expect(bracket).toEqual([
      '[prove-timing] local-prove-window open',
      'in-realm prove',
      '[prove-timing] local-prove-window close'
    ]);
  });
});
