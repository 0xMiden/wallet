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
import { ConsumeTransaction, SendTransaction, SwapTransaction } from '../db/types';
import { type ConsumableNote, NoteTypeEnum } from '../types';
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
  const applyFailure: { error?: Error } = {};
  const submitProven = jest.fn(async (_proof: unknown, _result: unknown) => {
    order.push('submitProven');
    return {
      apply: jest.fn(async () => {
        if (applyFailure.error) throw applyFailure.error;
        order.push('apply');
      })
    };
  });
  const allInOne = (label: string) =>
    jest.fn(async (...args: unknown[]) => {
      const options = args.find(
        (arg): arg is { prover?: unknown } => typeof arg === 'object' && arg !== null && 'prover' in arg
      );
      if (options?.prover === 'local') throw new Error(IN_REALM);
      // Recorded before its outcome, so a failed delegated call still shows in `order`.
      order.push(label);
      if (delegated.fail) throw new Error('remote prover unavailable');
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
    applyFailure,
    fakeClient,
    inner,
    transport,
    setWorkerProve(impl: typeof proveImpl) {
      proveImpl = impl;
    }
  };
}

type Harness = ReturnType<typeof buildHarness>;

function installMocks(
  harness: Harness,
  { proverUrl, newRemoteProver = jest.fn(() => 'remote') }: { proverUrl?: string; newRemoteProver?: jest.Mock } = {}
) {
  jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
    MidenClient: { create: jest.fn(async () => harness.fakeClient) },
    NoteFile: { deserialize: jest.fn() },
    AccountFile: { deserialize: jest.fn() },
    NoteExportFormat: { Id: 'Id', Full: 'Full', Details: 'Details' },
    NoteType: { Private: 'Private', Public: 'Public' },
    TransactionRequest: { deserialize: jest.fn((bytes: Uint8Array) => ({ requestBytes: Array.from(bytes) })) },
    TransactionProver: {
      newRemoteProver,
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
    getEffectiveProverUrl: () => proverUrl,
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
  expect(harness.transport.prove.mock.calls[0]?.[0]).toEqual({ txResult: new Uint8Array([7, 7]) });
  expect(harness.submitProven).toHaveBeenCalledWith({ proofBytes: [5, 5] }, harness.result);
}

describe('a trap is not a prover failure', () => {
  const proveTrap = new WebAssembly.RuntimeError('unreachable');

  it.each<[string, unknown, PromiseSettledResult<unknown>['status'], unknown, number]>([
    ['a trap', proveTrap, 'rejected', proveTrap, 1],
    ['a delegated failure', new Error('bad endpoint'), 'fulfilled', 'local', 2]
  ])(
    'proveWithFallback after %s re-proves locally only when it is not a trap',
    async (_kind, failure, status, settledWith, calls) => {
      const { proveWithFallback, withWasmClientLock } = await load(buildHarness());
      const fn = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue('local');
      const [settled] = await Promise.allSettled([
        withWasmClientLock(async () => proveWithFallback(fn, true, { disposed: false }))
      ]);
      expect(settled.status).toBe(status);
      expect(settled.status === 'rejected' ? settled.reason : settled.value).toBe(settledWith);
      expect(fn).toHaveBeenCalledTimes(calls);
    }
  );

  it('remoteProver rethrows a trap and answers undefined for a construction failure', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const newRemoteProver = jest.fn(() => {
      throw trap;
    });
    installMocks(buildHarness(), { proverUrl: 'https://prover.example', newRemoteProver });
    const { remoteProver } = await import('./miden-client-interface');
    let thrown: unknown;
    try {
      remoteProver();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(trap);
    newRemoteProver.mockImplementation(() => {
      throw new Error('bad endpoint');
    });
    expect(remoteProver()).toBeUndefined();
  });
});

describe('send (site 5)', () => {
  it('a local attempt proves in the worker, then submits the proof and applies it', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    const stages: string[] = [];
    // Stages push into the SAME `order` array as the worker/submit/apply steps, not a
    // separate one: a stage stamp is only pinned relative to the write's other steps
    // if both live in one timeline (#945 review: a mutant moving the 'submitting'
    // stamp after `submitProven` left `stages` alone and passed with two arrays).
    const returned = await withWasmClientLock(async () =>
      client.sendTransaction(sendTx(false), stage => {
        stages.push(stage);
        harness.order.push(`stage:${stage}`);
      })
    );
    expectWorkerProved(harness);
    expect(returned).toBe(harness.result);
    expect(harness.order).toEqual([
      'prewarm',
      'stage:executing',
      'stage:proving',
      'worker prove',
      'stage:submitting',
      'submitProven',
      'apply'
    ]);
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
    const { client, withWasmClientLock, WasmClientPoisonedError } = await load(harness);
    const sending = withWasmClientLock(async () => client.sendTransaction(sendTx(false))).catch(
      (error: unknown) => error
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.transport.prove).toHaveBeenCalledTimes(1);
    // A trap anywhere in the realm evicts the current holder at once (#775).
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
    const error = await sending;
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.submitProven).not.toHaveBeenCalled();
    // Must be WasmClientPoisonedError (abandoned, may have submitted), never
    // ProveWorkerError (a clean pre-submit failure the pipeline may requeue) - routing
    // an eviction onto the requeue path would let a corpse's write repeat (CLAUDE.md).
    expect(error).toBeInstanceOf(WasmClientPoisonedError);
  });

  it('an eviction cancels the worker prove, and the abandoned send fails as poisoned without submitting', async () => {
    const harness = buildHarness();
    // A worker that answers only through the cancel, as the real client does on an eviction.
    harness.setWorkerProve(
      (_request, options) => options?.cancel ?? Promise.reject(new Error('no cancel reached the transport'))
    );
    const { client, withWasmClientLock, WasmClientPoisonedError } = await load(harness);
    const { ProveWorkerError } = await import('./local-prove-transport');
    let inner: Promise<unknown> | undefined;
    const sending = withWasmClientLock(async () => {
      inner = client.sendTransaction(sendTx(false));
      return inner;
    }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.transport.prove).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
    await sending;
    const abandoned = await inner?.catch((caught: unknown) => caught);
    expect(abandoned).toBeInstanceOf(WasmClientPoisonedError);
    expect(abandoned).not.toBeInstanceOf(ProveWorkerError);
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

  it('an eviction during the worker prove stops the write before submit', async () => {
    const harness = buildHarness();
    let finish!: () => void;
    harness.setWorkerProve(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ proven: new Uint8Array([5]), durationMs: 1 });
        })
    );
    const { client, withWasmClientLock, WasmClientPoisonedError } = await load(harness);
    const running = withWasmClientLock(async () => client.newTransaction('acct', new Uint8Array([4]), false)).catch(
      (error: unknown) => error
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.transport.prove).toHaveBeenCalledTimes(1);
    // A trap anywhere in the realm evicts the current holder at once (#775).
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
    const error = await running;
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.submitProven).not.toHaveBeenCalled();
    // Same gate as the send-side eviction test: the post-prove hold re-check is
    // `proveInWorker`'s (`local-prove-transport.ts`), shared by every staged site, not
    // something site 6 duplicates - this pins that sharing, not a second mechanism.
    expect(error).toBeInstanceOf(WasmClientPoisonedError);
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

const note = (id: string): ConsumableNote => ({
  id,
  faucetId: 'faucet',
  amount: '1',
  senderAddress: 'sender',
  isBeingClaimed: false,
  type: NoteTypeEnum.Public
});

const consumeTx = (delegateTransaction: boolean) =>
  new ConsumeTransaction('acct', [note('n1'), note('n2')], delegateTransaction);

describe('consume (site 7)', () => {
  it('a local attempt builds the SDK consume request, executes it and proves in the worker', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    const returned = await withWasmClientLock(async () => client.consumeNoteId(consumeTx(false)));

    expect(harness.inner.getInputNote.mock.calls.map(call => call[0])).toEqual(['n1', 'n2']);
    const [notes, account] = harness.inner.newConsumeTransactionRequest.mock.calls[0] ?? [];
    expect(notes).toEqual([{ note: 'n1' }, { note: 'n2' }]);
    expect(String(account)).toBe('sdk-acct');
    expect(harness.executeRequest).toHaveBeenCalledWith('sdk-acct', { requestBytes: [3, 3] });
    expectWorkerProved(harness);
    expect(returned).toBe(harness.result);
    expect(harness.fakeClient.transactions.consume).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['prewarm', 'worker prove', 'submitProven', 'apply']);
  });

  it('a delegated consume that fails re-proves in the worker', async () => {
    const harness = buildHarness();
    harness.delegated.fail = true;
    const { client, withWasmClientLock } = await load(harness);
    await withWasmClientLock(async () => client.consumeNoteId(consumeTx(true)));
    expect(harness.fakeClient.transactions.consume).toHaveBeenCalledTimes(1);
    expectWorkerProved(harness);
    expect(harness.order).toEqual(['delegated consume', 'worker prove', 'submitProven', 'apply']);
  });

  it('a delegated consume that succeeds keeps the all-in-one call and never the worker', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    await withWasmClientLock(async () => client.consumeNoteId(consumeTx(true)));
    expect(harness.order).toEqual(['delegated consume']);
    expect(harness.transport.prove).not.toHaveBeenCalled();
    expect(harness.executeRequest).not.toHaveBeenCalled();
  });

  it('an eviction during the worker prove stops the consume before submit', async () => {
    const harness = buildHarness();
    let finish!: () => void;
    harness.setWorkerProve(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ proven: new Uint8Array([5]), durationMs: 1 });
        })
    );
    const { client, withWasmClientLock, WasmClientPoisonedError } = await load(harness);
    const consuming = withWasmClientLock(async () => client.consumeNoteId(consumeTx(false))).catch(
      (error: unknown) => error
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.transport.prove).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
    const error = await consuming;
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.submitProven).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(WasmClientPoisonedError);
  });

  it('a worker failure fails the consume before submit', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    harness.setWorkerProve(async () => {
      throw new Error('worker gone');
    });
    await expect(withWasmClientLock(async () => client.consumeNoteId(consumeTx(false)))).rejects.toThrow('worker gone');
    expect(harness.submitProven).not.toHaveBeenCalled();
  });

  it('fails a local consume loudly when the SDK lacks its inner-client escape hatch', async () => {
    const harness = buildHarness();
    Reflect.deleteProperty(harness.fakeClient, '_withInnerWebClient');
    const { client, withWasmClientLock } = await load(harness);
    await expect(withWasmClientLock(async () => client.consumeNoteId(consumeTx(false)))).rejects.toThrow(
      '_withInnerWebClient missing'
    );
    expect(harness.transport.prove).not.toHaveBeenCalled();
  });

  it('a note missing from the store fails the consume before anything executes', async () => {
    const harness = buildHarness();
    harness.inner.getInputNote.mockImplementation(async (id: string) =>
      id === 'n2' ? undefined : { toNote: () => ({ note: id }) }
    );
    const { client, withWasmClientLock } = await load(harness);
    await expect(withWasmClientLock(async () => client.consumeNoteId(consumeTx(false)))).rejects.toThrow(
      'Note not found: n2'
    );
    expect(harness.executeRequest).not.toHaveBeenCalled();
    expect(harness.transport.prove).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['prewarm']);
  });
});

const swapTx = (delegateTransaction: boolean) =>
  new SwapTransaction('acct', 'offered', 5n, 'requested', 7n, delegateTransaction);

describe('swap (site 8)', () => {
  it('a local attempt executes the PSWAP request it built and proves in the worker', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    const returned = await withWasmClientLock(async () => client.swapTransaction(swapTx(false)));
    expect(harness.executeRequest).toHaveBeenCalledWith('sdk-acct', { pswapRequest: true });
    expectWorkerProved(harness);
    expect(returned).toBe(harness.result);
    expect(harness.fakeClient.transactions.submit).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['prewarm', 'worker prove', 'submitProven', 'apply']);
  });

  it('a delegated swap keeps the all-in-one submit, and its failure never falls back', async () => {
    const harness = buildHarness();
    harness.delegated.fail = true;
    const { client, withWasmClientLock } = await load(harness);
    await expect(withWasmClientLock(async () => client.swapTransaction(swapTx(true)))).rejects.toThrow(
      'remote prover unavailable'
    );
    expect(harness.fakeClient.transactions.submit).toHaveBeenCalledTimes(1);
    expect(harness.transport.prove).not.toHaveBeenCalled();
    expect(harness.executeRequest).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['delegated swap submit']);
  });

  it('a delegated swap that fails before its point of no return falls back to the worker', async () => {
    const harness = buildHarness();
    harness.fakeClient.accounts.get.mockImplementationOnce(async () => {
      harness.order.push('delegated read failed');
      throw new Error('account read failed');
    });
    const { client, withWasmClientLock } = await load(harness);
    const returned = await withWasmClientLock(async () => client.swapTransaction(swapTx(true)));
    expectWorkerProved(harness);
    expect(returned).toBe(harness.result);
    expect(harness.fakeClient.transactions.submit).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['delegated read failed', 'worker prove', 'submitProven', 'apply']);
  });

  it('an eviction during the worker prove stops the swap before submit', async () => {
    const harness = buildHarness();
    let finish!: () => void;
    harness.setWorkerProve(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ proven: new Uint8Array([5]), durationMs: 1 });
        })
    );
    const { client, withWasmClientLock, WasmClientPoisonedError } = await load(harness);
    const swapping = withWasmClientLock(async () => client.swapTransaction(swapTx(false))).catch(
      (error: unknown) => error
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.transport.prove).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
    const error = await swapping;
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.submitProven).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(WasmClientPoisonedError);
  });

  it('a worker failure fails the swap before submit', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    harness.setWorkerProve(async () => {
      throw new Error('worker gone');
    });
    await expect(withWasmClientLock(async () => client.swapTransaction(swapTx(false)))).rejects.toThrow('worker gone');
    expect(harness.submitProven).not.toHaveBeenCalled();
  });
});

type LoadedClient = Awaited<ReturnType<typeof load>>['client'];

describe('the node has the write once submitProven resolves', () => {
  const legs: Array<[string, (client: LoadedClient) => Promise<unknown>]> = [
    ['send', client => client.sendTransaction(sendTx(false))],
    ['consume', client => client.consumeNoteId(consumeTx(false))],
    ['swap', client => client.swapTransaction(swapTx(false))],
    ['newTransaction', client => client.newTransaction('acct', new Uint8Array([4]), false)]
  ];

  it.each(legs)('a %s whose apply fails carries the apply-after-submit code and its cause', async (_leg, write) => {
    const harness = buildHarness();
    const storeQuota = new Error('store quota');
    harness.applyFailure.error = storeQuota;
    const { client, withWasmClientLock } = await load(harness);
    const { extractSdkErrorCode, isApplyAfterSubmitError } = await import('./sdk-error-code');
    const error = await withWasmClientLock(async () => write(client)).catch((caught: unknown) => caught);
    expect(harness.submitProven).toHaveBeenCalledTimes(1);
    expect(isApplyAfterSubmitError(error)).toBe(true);
    expect(extractSdkErrorCode(error)).toBe('ApplyTransactionAfterSubmitFailed');
    expect(error).toHaveProperty('cause', storeQuota);
  });

  it.each(legs)('a %s whose submitProven rejects reaches the caller unwrapped', async (_leg, write) => {
    const harness = buildHarness();
    const refused = new Error('node refused the transaction');
    harness.submitProven.mockRejectedValueOnce(refused);
    const { client, withWasmClientLock } = await load(harness);
    const { isApplyAfterSubmitError } = await import('./sdk-error-code');
    const error = await withWasmClientLock(async () => write(client)).catch((caught: unknown) => caught);
    expect(error).toBe(refused);
    expect(isApplyAfterSubmitError(error)).toBe(false);
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
    // Restore, not overwrite: an unset flag must stay unset, or later suites reading
    // `process.env.MIDEN_E2E_TEST === 'true'` would see the STRING "undefined" (truthy
    // is not the bug here, but the literal value leaking into later tests is).
    if (realFlag === undefined) {
      delete process.env.MIDEN_E2E_TEST;
    } else {
      process.env.MIDEN_E2E_TEST = realFlag;
    }
  });

  it('brackets an in-realm local prove with the window markers the E2E gap check reads', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const trail: string[] = [];
    jest.doMock('./prove-telemetry', () => ({
      ...jest.requireActual<typeof import('./prove-telemetry')>('./prove-telemetry'),
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

  it('emits no local-prove-window markers for a delegated attempt or a disposed client', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const trail: string[] = [];
    jest.doMock('./prove-telemetry', () => ({
      ...jest.requireActual<typeof import('./prove-telemetry')>('./prove-telemetry'),
      recordProveMarker: (line: string) => trail.push(line)
    }));
    const harness = buildHarness();
    const { proveWithFallback } = await load(harness, false);
    // Delegated: `localProveAttempt` is false, so the gate short-circuits before the
    // marker regardless of liveness.
    await proveWithFallback(
      async (_prover, attempt) => attempt.pauseWatchdogForLocalProve(async () => trail.push('delegated prove')),
      true,
      { disposed: false }
    );
    // Local but disposed: the same gate's OTHER half - an evicted flow's corpse must
    // not open a window either.
    await proveWithFallback(
      async (_prover, attempt) => attempt.pauseWatchdogForLocalProve(async () => trail.push('disposed prove')),
      false,
      { disposed: true }
    );
    expect(trail.filter(line => line.includes('local-prove-window'))).toEqual([]);
  });
});
