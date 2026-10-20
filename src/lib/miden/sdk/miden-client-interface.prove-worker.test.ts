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
import { installHiddenDocument } from 'lib/mobile/testing/hidden-document';

import { ConsumeTransaction, SendTransaction, SwapTransaction } from '../db/types';
import { type ConsumableNote, NoteTypeEnum } from '../types';
import { APPLY_RETRY_DELAYS_MS } from './apply-after-submit';
import type { LocalProveOptions, LocalProveRequest } from './local-prove-transport';

const IN_REALM = 'in-realm prove reached';

type ProveOptions = { prover?: unknown } | undefined;

function buildHarness() {
  const order: string[] = [];
  const result = { serialize: jest.fn(() => new Uint8Array([7, 7])) };
  // `onProve` runs inside a delegated prove, before it settles.
  const delegated: { fail: boolean; onProve?: () => void } = { fail: false };
  // Set, a local prove may run in this realm (no transport), and it runs this first.
  const inRealm: { onLocalProve?: () => void } = {};
  const stagedApply = jest.fn(async () => {
    order.push('apply');
  });
  const executeRequest = jest.fn(async (_account: string, _request: unknown) => ({
    result,
    prove: jest.fn(async (options: ProveOptions) => {
      const leg = options?.prover === 'local' ? 'local' : 'delegated';
      if (leg === 'local') {
        if (!inRealm.onLocalProve) throw new Error(IN_REALM);
        inRealm.onLocalProve();
      } else {
        delegated.onProve?.();
        if (delegated.fail) throw new Error('remote prover unavailable');
      }
      order.push(`${leg} prove`);
      return {
        submit: jest.fn(async () => {
          order.push(`${leg} submit`);
          return { apply: stagedApply };
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
    getAccount: jest.fn(async (_accountId?: unknown): Promise<unknown> => ({ vault: jest.fn() })),
    getInputNote: jest.fn(
      async (id: string): Promise<{ toNote: () => { note: string } } | undefined> => ({ toNote: () => ({ note: id }) })
    ),
    newConsumeTransactionRequest: jest.fn(async (_notes: unknown[], _account: unknown) => ({
      serialize: () => new Uint8Array([3, 3])
    })),
    newPswapCreateTransactionRequest: jest.fn(async () => ({ reference: true })),
    // The offscreen-proved path executes, submits and applies on this inner client.
    executeTransaction: jest.fn(async (_account: unknown, _request: unknown) => result),
    submitProvenTransaction: jest.fn(async (_proven: unknown, _result: unknown) => 1),
    applyTransaction: jest.fn(async (_result: unknown, _height: unknown) => {
      order.push('apply');
    })
  };
  const fakeClient = {
    transactions: {
      executeRequest,
      submitProven,
      consume: allInOne('delegated consume'),
      submit: allInOne('delegated swap submit')
    },
    accounts: { get: jest.fn(async (_accountId?: unknown): Promise<unknown> => ({ account: true })) },
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
    inRealm,
    executeRequest,
    stagedApply,
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

function sdkLazyMock(harness: Harness, newRemoteProver: jest.Mock = jest.fn(() => 'remote')) {
  return {
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
      NoteType: { Public: 'public', Private: 'private' },
      ProvenTransaction: { deserialize: jest.fn((bytes: Uint8Array) => ({ proofBytes: Array.from(bytes) })) }
    })),
    WasmWebClient: { createClient: jest.fn() },
    exportStore: jest.fn(),
    importStore: jest.fn()
  };
}

function installMocks(
  harness: Harness,
  { proverUrl, newRemoteProver }: { proverUrl?: string; newRemoteProver?: jest.Mock } = {}
) {
  jest.doMock('@miden-sdk/miden-sdk/lazy', () => sdkLazyMock(harness, newRemoteProver));
  jest.doMock('lib/miden-chain/effective-endpoints', () => ({
    getEffectiveNetworkName: () => 'localnet',
    getEffectiveRpcUrl: () => 'rpc-local',
    getEffectiveProverUrl: () => proverUrl,
    getEffectiveNoteTransportUrl: () => undefined,
    getEffectiveFeeFaucetId: () => '0xfee'
  }));
  jest.doMock('./helpers', () => ({
    getBech32AddressFromAccountId: (id: unknown) => String(id),
    walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
    accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
    canonicalWalletAccountId: (id: string) => `sdk-${id}`,
    buildSendTransactionRequest: jest.fn(() => ({ serialize: () => new Uint8Array([1]) })),
    buildPswapCreateRequest: jest.fn(() => ({ pswapRequest: true })),
    buildConsumeTransactionRequest: jest.fn((_notes: unknown[], _expirationDelta: number) => ({
      serialize: () => new Uint8Array([3, 3])
    }))
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

/**
 * The service worker's offscreen-proved path (`proveLocallyViaOffscreen`): no transport in this
 * realm, and a local attempt proves in the offscreen document between two holds of the lock.
 */
async function loadOffscreenProved(harness: Harness, afterProve: () => void = () => undefined) {
  process.env.MIDEN_USE_OFFSCREEN_PROVING = 'true';
  installMocks(harness);
  const lazy = sdkLazyMock(harness);
  // `isLocalProver` reads the prover's serialized form.
  jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
    ...lazy,
    TransactionProver: { ...lazy.TransactionProver, newLocalProver: jest.fn(() => ({ serialize: () => 'local' })) }
  }));
  jest.doMock('lib/miden/back/offscreen-prover', () => ({
    isOffscreenAvailable: () => true,
    proveViaOffscreen: jest.fn(async () => {
      afterProve();
      return { provenBytes: new Uint8Array([6]).buffer, durationMs: 1 };
    })
  }));
  const { MidenClientInterface } = await import('./miden-client-interface');
  const { withWasmClientLock } = await import('./miden-client');
  const { WasmClientPoisonedError } = await import('./wasm-client-poison');
  const client = await MidenClientInterface.create();
  return { client, withWasmClientLock, WasmClientPoisonedError };
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

describe('remoteProver transport deadline (#473)', () => {
  afterEach(() => {
    jest.dontMock('lib/platform');
  });

  it.each<[string, boolean, number]>([
    ['on mobile it is the 120 s delegated deadline', true, 120_000],
    ['on the extension and desktop it is the 120 s delegated deadline', false, 120_000]
  ])('%s', async (_platform, mobile, deadlineMs) => {
    jest.doMock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isMobile: () => mobile }));
    const newRemoteProver = jest.fn(() => 'remote');
    installMocks(buildHarness(), { proverUrl: 'https://prover.example', newRemoteProver });
    const { remoteProver } = await import('./miden-client-interface');

    expect(remoteProver()).toBe('remote');
    expect(newRemoteProver).toHaveBeenCalledWith('https://prover.example', BigInt(deadlineMs));
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
  it('a local attempt builds the consume request, executes it and proves in the worker', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    const returned = await withWasmClientLock(async () => client.consumeNoteId(consumeTx(false)));

    expect(harness.inner.getInputNote.mock.calls.map(call => call[0])).toEqual(['n1', 'n2']);
    const { buildConsumeTransactionRequest } = jest.requireMock('./helpers');
    expect(buildConsumeTransactionRequest).toHaveBeenCalledWith([{ note: 'n1' }, { note: 'n2' }], 600);
    expect(harness.inner.newConsumeTransactionRequest).not.toHaveBeenCalled();
    expect(harness.executeRequest).toHaveBeenCalledWith('sdk-acct', { requestBytes: [3, 3] });
    expectWorkerProved(harness);
    expect(returned).toBe(harness.result);
    expect(harness.fakeClient.transactions.consume).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['prewarm', 'worker prove', 'submitProven', 'apply']);
  });

  it('a delegated consume whose prove fails re-proves in the worker', async () => {
    const harness = buildHarness();
    harness.delegated.fail = true;
    const { client, withWasmClientLock } = await load(harness);
    await withWasmClientLock(async () => client.consumeNoteId(consumeTx(true)));
    // Staged (#1233): the delegated attempt executes and fails at its prove, and the fallback
    // executes again and proves in the worker.
    expect(harness.fakeClient.transactions.consume).not.toHaveBeenCalled();
    expect(harness.executeRequest).toHaveBeenCalledTimes(2);
    expectWorkerProved(harness);
    expect(harness.order).toEqual(['worker prove', 'submitProven', 'apply']);
  });

  it('a delegated consume that succeeds proves remotely, submits and applies, and never touches the worker', async () => {
    const harness = buildHarness();
    const { client, withWasmClientLock } = await load(harness);
    await withWasmClientLock(async () => client.consumeNoteId(consumeTx(true)));
    expect(harness.order).toEqual(['delegated prove', 'delegated submit', 'apply']);
    expect(harness.transport.prove).not.toHaveBeenCalled();
    expect(harness.executeRequest).toHaveBeenCalledTimes(1);
    expect(harness.fakeClient.transactions.consume).not.toHaveBeenCalled();
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

  it('a delegated swap whose prove fails falls back to the worker', async () => {
    const harness = buildHarness();
    harness.delegated.fail = true;
    const { client, withWasmClientLock } = await load(harness);
    const returned = await withWasmClientLock(async () => client.swapTransaction(swapTx(true)));
    // Staged (#1233): the prove is pre-submit, so a delegated one that fails falls back.
    expect(returned).toBe(harness.result);
    expect(harness.fakeClient.transactions.submit).not.toHaveBeenCalled();
    expect(harness.executeRequest).toHaveBeenCalledTimes(2);
    expectWorkerProved(harness);
    expect(harness.order).toEqual(['worker prove', 'submitProven', 'apply']);
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

/** Runs the apply retry's waits on fake timers, so a failed apply costs no real time (#1233). */
async function afterApplyRetryWaits<T>(pending: Promise<T>): Promise<T> {
  await jest.advanceTimersByTimeAsync(APPLY_RETRY_DELAYS_MS.reduce((total, ms) => total + ms, 0));
  return pending;
}

describe('the node has the write once submitProven resolves', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

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
    jest.useFakeTimers();
    const error = await afterApplyRetryWaits(
      withWasmClientLock(async () => write(client)).catch((caught: unknown) => caught)
    );
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

  it.each(legs)('a %s whose first apply fails and whose retry lands resolves (#1233)', async (_leg, write) => {
    const harness = buildHarness();
    // Not the leg's own `sdk-acct`, which the swap leg also reads: only the executed account's id
    // finds the initial commitment, so a retry that reads any other account fails closed.
    Object.assign(harness.result, {
      executedTransaction: () => ({
        id: () => ({ toHex: () => '0xlanded' }),
        accountId: () => 'sdk-executed-acct',
        initialAccountHeader: () => ({ to_commitment: () => ({ toHex: () => '0xinitial' }) })
      })
    });
    harness.fakeClient.accounts.get.mockImplementation(async (accountId?: unknown) =>
      accountId === 'sdk-executed-acct' ? { to_commitment: () => ({ toHex: () => '0xinitial' }) } : null
    );
    const apply = jest.fn(async () => {}).mockRejectedValueOnce(new Error('store abort'));
    harness.submitProven.mockImplementationOnce(async () => {
      harness.order.push('submitProven');
      return { apply };
    });
    const { client, withWasmClientLock } = await load(harness);
    jest.useFakeTimers();

    await expect(afterApplyRetryWaits(withWasmClientLock(async () => write(client)))).resolves.toBe(harness.result);

    expect(apply).toHaveBeenCalledTimes(2);
    expect(harness.submitProven).toHaveBeenCalledTimes(1);
    expect(harness.fakeClient.accounts.get).toHaveBeenCalledWith('sdk-executed-acct');
  });
});

describe('the apply retry at the plain staged sites (#1233)', () => {
  const realOffscreenFlag = process.env.MIDEN_USE_OFFSCREEN_PROVING;
  afterEach(() => {
    jest.useRealTimers();
    if (realOffscreenFlag === undefined) {
      delete process.env.MIDEN_USE_OFFSCREEN_PROVING;
    } else {
      process.env.MIDEN_USE_OFFSCREEN_PROVING = realOffscreenFlag;
    }
  });

  type Loaded = Pick<Awaited<ReturnType<typeof load>>, 'client' | 'withWasmClientLock' | 'WasmClientPoisonedError'>;
  interface Site {
    load: (harness: Harness) => Promise<Loaded>;
    write: (client: LoadedClient) => Promise<unknown>;
    /** The apply the site retries, the client read it must use, and the other client's read. */
    parts: (harness: Harness) => { apply: jest.Mock; siteReader: jest.Mock; otherReader: jest.Mock };
  }
  const stagedParts = (harness: Harness) => ({
    apply: harness.stagedApply,
    siteReader: harness.fakeClient.accounts.get,
    otherReader: harness.inner.getAccount
  });
  // Every write runs under the lock the proxy takes around it, with no transport, as in the service
  // worker. The staged legs are delegated; the offscreen-proved one is local.
  const sites: Array<[string, Site]> = [
    [
      'send staged leg',
      {
        load: harness => load(harness, false),
        write: client => client.sendTransaction(sendTx(true)),
        parts: stagedParts
      }
    ],
    [
      'newTransaction staged leg',
      {
        load: harness => load(harness, false),
        write: client => client.newTransaction('acct', new Uint8Array([4]), true),
        parts: stagedParts
      }
    ],
    [
      'consume staged leg',
      {
        load: harness => load(harness, false),
        write: client => client.consumeNoteId(consumeTx(true)),
        parts: stagedParts
      }
    ],
    [
      'swap staged leg',
      {
        load: harness => load(harness, false),
        write: client => client.swapTransaction(swapTx(true)),
        parts: stagedParts
      }
    ],
    [
      'offscreen-proved write',
      {
        load: loadOffscreenProved,
        write: client => client.newTransaction('acct', new Uint8Array([4]), false),
        parts: harness => ({
          apply: harness.inner.applyTransaction,
          siteReader: harness.inner.getAccount,
          otherReader: harness.fakeClient.accounts.get
        })
      }
    ]
  ];

  // The executed account's id is none the leg reads for itself, and only the site's own client
  // holds the initial commitment for it: a retry that reads another id or another client fails
  // closed, and the write rejects instead of landing.
  const arrange = (harness: Harness, site: Site) => {
    Object.assign(harness.result, {
      executedTransaction: () => ({
        id: () => ({ toHex: () => '0xlanded' }),
        accountId: () => 'sdk-executed-acct',
        initialAccountHeader: () => ({ to_commitment: () => ({ toHex: () => '0xinitial' }) })
      })
    });
    const { apply, siteReader, otherReader } = site.parts(harness);
    siteReader.mockImplementation(async (accountId?: unknown) =>
      accountId === 'sdk-executed-acct' ? { to_commitment: () => ({ toHex: () => '0xinitial' }) } : null
    );
    // `vault` for the send leg's request build, which reads this same inner client.
    otherReader.mockImplementation(async () => ({
      vault: jest.fn(),
      to_commitment: () => ({ toHex: () => '0xother-client' })
    }));
    return { apply, siteReader };
  };

  it.each(sites)("%s: a failed apply is retried through the site's own client and lands", async (_site, site) => {
    const harness = buildHarness();
    const { apply, siteReader } = arrange(harness, site);
    apply.mockRejectedValueOnce(new Error('IndexedDB transaction aborted'));
    const { client, withWasmClientLock } = await site.load(harness);
    jest.useFakeTimers();

    await expect(afterApplyRetryWaits(withWasmClientLock(async () => site.write(client)))).resolves.toBe(
      harness.result
    );

    expect(apply).toHaveBeenCalledTimes(2);
    expect(siteReader).toHaveBeenCalledWith('sdk-executed-acct');
  });

  it.each(sites)(
    '%s: an apply whose hold is evicted after the first failure is not applied again',
    async (_site, site) => {
      const harness = buildHarness();
      const { apply, siteReader } = arrange(harness, site);
      // The store still holds the initial account, so only the hold check can stop a second apply.
      apply.mockImplementationOnce(async () => {
        window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
        throw new Error('IndexedDB transaction aborted');
      });
      const { client, withWasmClientLock, WasmClientPoisonedError } = await site.load(harness);
      const { isApplyAfterSubmitError } = await import('./sdk-error-code');
      jest.useFakeTimers();
      let writing: Promise<unknown> = Promise.resolve();

      const lockError = await withWasmClientLock(async () => {
        writing = site.write(client);
        return writing;
      }).catch((caught: unknown) => caught);
      // The eviction settles the lock first; the abandoned write keeps running and ends on its own.
      const abandoned = await afterApplyRetryWaits(writing.catch((caught: unknown) => caught));

      expect(lockError).toBeInstanceOf(WasmClientPoisonedError);
      expect(isApplyAfterSubmitError(abandoned)).toBe(true);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(siteReader).not.toHaveBeenCalledWith('sdk-executed-acct');
    }
  );
});

describe('an eviction during the in-realm leg (#1233)', () => {
  // As in the service worker with the offscreen flag off: no transport, so the delegated leg and
  // its fallback both prove in this realm, under the lock the proxy takes.
  const evict = () =>
    window.dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable') }));
  const runEvicted = async (harness: Harness) => {
    const { client, withWasmClientLock, WasmClientPoisonedError } = await load(harness, false);
    let abandoned: Promise<unknown> = Promise.resolve();
    const lockError = await withWasmClientLock(async () => {
      const writing = client.swapTransaction(swapTx(true));
      abandoned = writing.catch((caught: unknown) => caught);
      return writing;
    }).catch((caught: unknown) => caught);
    return { lockError, abandoned: await abandoned, WasmClientPoisonedError };
  };

  it('a delegated swap whose prove rejects after an eviction never proves locally or submits', async () => {
    const harness = buildHarness();
    harness.delegated.fail = true;
    harness.delegated.onProve = evict;
    harness.inRealm.onLocalProve = () => harness.order.push('local prove started');

    const { lockError, abandoned, WasmClientPoisonedError } = await runEvicted(harness);

    expect(lockError).toBeInstanceOf(WasmClientPoisonedError);
    expect(abandoned).toBeInstanceOf(WasmClientPoisonedError);
    expect(harness.executeRequest).toHaveBeenCalledTimes(1);
    expect(harness.order).toEqual([]);
  });

  it('an eviction while the in-realm prove is parked stops the swap before its point of no return', async () => {
    const harness = buildHarness();
    harness.delegated.onProve = evict;

    const { lockError, abandoned, WasmClientPoisonedError } = await runEvicted(harness);

    expect(lockError).toBeInstanceOf(WasmClientPoisonedError);
    expect(abandoned).toBeInstanceOf(WasmClientPoisonedError);
    // The prove resolved on the evicted client, and nothing after it ran.
    expect(harness.order).toEqual(['delegated prove']);
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

  it("says the write's hold is current only inside its lock and while its client is live (#1233)", async () => {
    const harness = buildHarness();
    const { proveWithFallback, withWasmClientLock } = await load(harness);
    const seen: boolean[] = [];
    const record = async (_prover: unknown, attempt: { holdIsCurrent(): boolean }) => {
      seen.push(attempt.holdIsCurrent());
      return null;
    };

    await withWasmClientLock(async () => proveWithFallback(record, false, { disposed: false }));
    await withWasmClientLock(async () => proveWithFallback(record, false, { disposed: true }));
    await proveWithFallback(record, false, { disposed: false });

    expect(seen).toEqual([true, false, false]);
  });

  it("says the write's hold is not current once another hold owns the lock, with its client live (#1233)", async () => {
    const harness = buildHarness();
    const { proveWithFallback, withWasmClientLock } = await load(harness);
    const attempts: Array<{ holdIsCurrent(): boolean }> = [];
    await withWasmClientLock(async () =>
      proveWithFallback(
        async (_prover, attempt) => {
          attempts.push(attempt);
          return null;
        },
        false,
        { disposed: false }
      )
    );
    const seen: boolean[] = [];

    // The attempt keeps its own non-null hold and a live client, so only the owner comparison can say no.
    await withWasmClientLock(async () => {
      for (const attempt of attempts) seen.push(attempt.holdIsCurrent());
    });

    expect(seen).toEqual([false]);
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

  it('a local in-realm consume proves between the window markers (the leg all four plain writes share)', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    const trail: string[] = [];
    jest.doMock('./prove-telemetry', () => ({
      ...jest.requireActual<typeof import('./prove-telemetry')>('./prove-telemetry'),
      recordProveMarker: (line: string) => trail.push(line)
    }));
    const harness = buildHarness();
    harness.inRealm.onLocalProve = () => trail.push('in-realm prove');
    const { client, withWasmClientLock } = await load(harness, false);
    await withWasmClientLock(async () => client.consumeNoteId(consumeTx(false)));
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

function permissionDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function observePermissionWrite<T>(writing: Promise<T>): Promise<PromiseSettledResult<T>> {
  return writing.then(
    (value): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason })
  );
}

async function realPermission(onRefresh: () => void = () => undefined) {
  // Scoped to these last cases: legacy cases keep their external boundary mock.
  jest.doMock('lib/remote-config/wallet-access', () => jest.requireActual('lib/remote-config/wallet-access'));
  jest.dontMock('./miden-client');
  jest.dontMock('lib/miden/sdk/miden-client');
  const access = await import('lib/remote-config/wallet-access');
  const response = permissionDeferred<boolean | null>();
  const entered = permissionDeferred<void>();
  let now = 1_000;
  let refreshes = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const scope = () => `permission-proof:${access.getWalletAccessGeneration()}`;
  access.registerWalletAccessRuntime({
    scope,
    refresh: async () => {
      const ownerScope = scope();
      refreshes += 1;
      onRefresh();
      entered.resolve();
      const allowed = await response.promise;
      access.publishWalletAccessDecision(ownerScope, allowed);
    }
  });
  access.publishWalletAccessDecision(scope(), true);
  return {
    access,
    entered: entered.promise,
    respond: response.resolve,
    expire: () => {
      now += 60_001;
    },
    refreshCount: () => refreshes,
    close: () => access.invalidateWalletAccess()
  };
}

type PermissionControl = Awaited<ReturnType<typeof realPermission>>;
type PermissionProofPath = 'worker' | 'in-realm' | 'offscreen-proved';
const permissionPaths: PermissionProofPath[] = ['worker', 'in-realm', 'offscreen-proved'];

async function loadPermissionWrite(path: PermissionProofPath, harness: Harness, permission: PermissionControl) {
  if (path === 'worker') {
    harness.setWorkerProve(async () => {
      harness.order.push('worker prove');
      permission.expire();
      return { proven: new Uint8Array([5, 5]), durationMs: 1 };
    });
    const loaded = await load(harness);
    return { ...loaded, run: () => loaded.client.consumeNoteId(consumeTx(false)) };
  }
  if (path === 'in-realm') {
    harness.delegated.onProve = permission.expire;
    const loaded = await load(harness, false);
    return { ...loaded, run: () => loaded.client.consumeNoteId(consumeTx(true)) };
  }
  const loaded = await loadOffscreenProved(harness, permission.expire);
  return { ...loaded, run: () => loaded.client.consumeNoteId(consumeTx(false)) };
}

function permissionSubmitCount(harness: Harness): number {
  return (
    harness.submitProven.mock.calls.length +
    harness.inner.submitProvenTransaction.mock.calls.length +
    harness.order.filter(step => step === 'delegated submit' || step === 'local submit').length
  );
}

function permissionExecutionCount(harness: Harness): number {
  return harness.executeRequest.mock.calls.length + harness.inner.executeTransaction.mock.calls.length;
}

async function expectPermissionSignal<T>(signal: Promise<void>, writing: Promise<PromiseSettledResult<T>>) {
  const first = await Promise.race([
    signal.then(() => ({ phase: 'permission signal' })),
    writing.then(outcome => ({ phase: 'write ended first', outcome }))
  ]);
  expect(first).toEqual({ phase: 'permission signal' });
}

describe('GEO007 permission renewal at final submit', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.MIDEN_USE_OFFSCREEN_PROVING = 'false';
  });
  const savedOffscreenFlag = process.env.MIDEN_USE_OFFSCREEN_PROVING;
  afterEach(() => {
    if (savedOffscreenFlag === undefined) delete process.env.MIDEN_USE_OFFSCREEN_PROVING;
    else process.env.MIDEN_USE_OFFSCREEN_PROVING = savedOffscreenFlag;
  });

  describe.each(permissionPaths)('%s proof path', path => {
    it.each([true, false])('admits a real mutex contender during renewal, allowed=%s', async allowed => {
      const harness = buildHarness();
      const permission = await realPermission();
      const loaded = await loadPermissionWrite(path, harness, permission);
      const locks = await import('./miden-client');
      const { hasErrorBeforeSubmit } = await import('./sdk-error-code');
      const outcome = observePermissionWrite(loaded.withWasmClientLock(loaded.run));
      try {
        await expectPermissionSignal(permission.entered, outcome);
        let contenderRan = false;
        const contender = await locks.tryWithWasmClientLock(async () => {
          contenderRan = true;
          return 'read completed';
        });
        // A parked authority request must not occupy the mutex background readers need.
        expect(contender).toEqual({ ran: true, value: 'read completed' });
        expect(contenderRan).toBe(true);
        expect(permissionSubmitCount(harness)).toBe(0);
        expect(harness.order.filter(step => step === 'apply')).toHaveLength(0);
      } finally {
        permission.respond(allowed);
        await outcome;
        permission.close();
      }
      const settled = await outcome;
      const error = settled.status === 'rejected' ? settled.reason : undefined;
      expect(settled.status).toBe(allowed ? 'fulfilled' : 'rejected');
      expect(permission.access.isWalletAccessDeniedError(error)).toBe(!allowed);
      expect(hasErrorBeforeSubmit(error)).toBe(!allowed);
      expect(permissionSubmitCount(harness)).toBe(allowed ? 1 : 0);
      expect(harness.order.filter(step => step === 'apply')).toHaveLength(allowed ? 1 : 0);
      expect(permissionExecutionCount(harness)).toBe(1);
      expect(permission.refreshCount()).toBe(1);
      expect(await locks.tryWithWasmClientLock(async () => 'idle')).toEqual({ ran: true, value: 'idle' });
    });
  });

  it('an unavailable renewal stays pre-submit after admitting a mutex contender', async () => {
    const harness = buildHarness();
    const permission = await realPermission();
    const loaded = await loadPermissionWrite('in-realm', harness, permission);
    const locks = await import('./miden-client');
    const { hasErrorBeforeSubmit } = await import('./sdk-error-code');
    const outcome = observePermissionWrite(loaded.withWasmClientLock(loaded.run));
    try {
      await expectPermissionSignal(permission.entered, outcome);
      expect(await locks.tryWithWasmClientLock(async () => 'read')).toEqual({ ran: true, value: 'read' });
    } finally {
      permission.respond(null);
      await outcome;
      permission.close();
    }
    const settled = await outcome;
    const error = settled.status === 'rejected' ? settled.reason : undefined;
    expect(settled.status).toBe('rejected');
    expect(permission.access.isWalletAccessDeniedError(error)).toBe(true);
    expect(hasErrorBeforeSubmit(error)).toBe(true);
    expect(permissionSubmitCount(harness)).toBe(0);
    expect(permissionExecutionCount(harness)).toBe(1);
  });

  it('a hidden long proof completes after demand renewal without anticipatory refresh', async () => {
    const harness = buildHarness();
    const permission = await realPermission();
    const proofEntered = permissionDeferred<void>();
    const finishProof = permissionDeferred<void>();
    const loaded = await loadPermissionWrite('worker', harness, permission);
    const locks = await import('./miden-client');
    const hidden = installHiddenDocument();
    const savedVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    hidden.setHidden(true, { dispatch: false });
    harness.setWorkerProve(async () => {
      proofEntered.resolve();
      await finishProof.promise;
      return { proven: new Uint8Array([5]), durationMs: 65_000 };
    });
    const outcome = observePermissionWrite(loaded.withWasmClientLock(loaded.run));
    try {
      await expectPermissionSignal(proofEntered.promise, outcome);
      permission.expire();
      expect(document.visibilityState).toBe('hidden');
      expect(document.hidden).toBe(true);
      expect(permission.access.getWalletAccessSnapshot().status).toBe('loading');
      expect(permission.refreshCount()).toBe(0);
      finishProof.resolve();
      await expectPermissionSignal(permission.entered, outcome);
      expect(await locks.tryWithWasmClientLock(async () => 'read')).toEqual({ ran: true, value: 'read' });
      expect(permissionSubmitCount(harness)).toBe(0);
    } finally {
      finishProof.resolve();
      permission.respond(true);
      await outcome;
      permission.close();
      hidden.restore();
      if (savedVisibility) Object.defineProperty(document, 'visibilityState', savedVisibility);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
    expect((await outcome).status).toBe('fulfilled');
    expect(permissionSubmitCount(harness)).toBe(1);
    expect(harness.order.filter(step => step === 'apply')).toHaveLength(1);
    expect(permission.refreshCount()).toBe(1);
  });

  it('a permission change before the SDK inner callback refuses without renewal inside the borrow', async () => {
    const harness = buildHarness();
    const refreshBorrowFlags: boolean[] = [];
    let innerBorrow = false;
    let innerCalls = 0;
    const permission = await realPermission(() => refreshBorrowFlags.push(innerBorrow));
    permission.respond(true);
    harness.fakeClient._withInnerWebClient.mockImplementation(async run => {
      innerCalls += 1;
      // The second window is submit/apply, after the proof-only offscreen wait.
      if (innerCalls === 2) permission.access.invalidateWalletAccess();
      innerBorrow = true;
      try {
        return await run(harness.inner);
      } finally {
        innerBorrow = false;
      }
    });
    const loaded = await loadOffscreenProved(harness);
    const { hasErrorBeforeSubmit } = await import('./sdk-error-code');
    const outcome = observePermissionWrite(
      loaded.withWasmClientLock(async () => loaded.client.consumeNoteId(consumeTx(false)))
    );
    let settled: Awaited<typeof outcome>;
    try {
      settled = await outcome;
    } finally {
      permission.close();
    }
    const error = settled.status === 'rejected' ? settled.reason : undefined;
    expect(settled.status).toBe('rejected');
    expect(permission.access.isWalletAccessDeniedError(error)).toBe(true);
    expect(hasErrorBeforeSubmit(error)).toBe(true);
    expect(refreshBorrowFlags).toEqual([]);
    expect(permissionSubmitCount(harness)).toBe(0);
    expect(harness.inner.applyTransaction).not.toHaveBeenCalled();
  });

  it('a replaced client generation cannot submit a proof retained across permission renewal', async () => {
    const harness = buildHarness();
    const permission = await realPermission();
    await loadPermissionWrite('worker', harness, permission);
    const locks = await import('./miden-client');
    const { wasmClientGeneration } = await import('./wasm-client-poison');
    // Recovery must know this instance, unlike a direct unmanaged interface.create().
    const client = await locks.getMidenClient();
    const generation = wasmClientGeneration();
    const outcome = observePermissionWrite(
      locks.withWasmClientLock(async () => client.consumeNoteId(consumeTx(false)))
    );
    try {
      await expectPermissionSignal(permission.entered, outcome);
      expect(await locks.tryWithWasmClientLock(async () => 'read')).toEqual({ ran: true, value: 'read' });
      await locks.resetMidenClient();
      expect(wasmClientGeneration()).toBeGreaterThan(generation);
      expect(client.isDisposed).toBe(true);
    } finally {
      permission.respond(true);
      await outcome;
      permission.close();
    }
    const settled = await outcome;
    const error = settled.status === 'rejected' ? settled.reason : undefined;
    expect(settled.status).toBe('rejected');
    const { isWasmClientPoisonedError } = await import('./wasm-client-poison');
    expect(isWasmClientPoisonedError(error)).toBe(true);
    expect(permissionSubmitCount(harness)).toBe(0);
    expect(harness.order.filter(step => step === 'apply')).toHaveLength(0);
    const replacement = await locks.getMidenClient();
    expect(replacement).not.toBe(client);
    expect(replacement.isDisposed).toBe(false);
    expect(await locks.tryWithWasmClientLock(async () => 'fresh')).toEqual({ ran: true, value: 'fresh' });
  });

  it('an unmanaged client with a changed realm generation cannot submit a retained proof', async () => {
    const harness = buildHarness();
    const permission = await realPermission();
    const loaded = await loadPermissionWrite('worker', harness, permission);
    const locks = await import('./miden-client');
    const { bumpWasmClientGeneration, isWasmClientPoisonedError, wasmClientGeneration } =
      await import('./wasm-client-poison');
    const generation = wasmClientGeneration();
    const outcome = observePermissionWrite(loaded.withWasmClientLock(loaded.run));
    try {
      await expectPermissionSignal(permission.entered, outcome);
      const contender = await locks.tryWithWasmClientLock(async () => {
        bumpWasmClientGeneration();
        return 'generation advanced';
      });
      expect(contender).toEqual({ ran: true, value: 'generation advanced' });
      expect(wasmClientGeneration()).toBe(generation + 1);
      expect(loaded.client.isDisposed).toBe(false);
      expect(permissionSubmitCount(harness)).toBe(0);
    } finally {
      permission.respond(true);
      await outcome;
      permission.close();
    }
    const settled = await outcome;
    const error = settled.status === 'rejected' ? settled.reason : undefined;
    expect(settled.status).toBe('rejected');
    expect(isWasmClientPoisonedError(error)).toBe(true);
    expect(loaded.client.isDisposed).toBe(false);
    expect(permissionSubmitCount(harness)).toBe(0);
    expect(harness.order.filter(step => step === 'apply')).toHaveLength(0);
    expect(permissionExecutionCount(harness)).toBe(1);
    expect(permission.refreshCount()).toBe(1);
    expect(await locks.tryWithWasmClientLock(async () => 'idle')).toEqual({ ran: true, value: 'idle' });
  });
});

describe('GEO014 proxy Swap feature authorization at final submit', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'false';
  });

  afterEach(() => {
    jest.dontMock('lib/remote-config/runtime');
    delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  });

  it.each([
    { mode: 'worker', allowed: true },
    { mode: 'worker', allowed: false },
    { mode: 'in-realm', allowed: true },
    { mode: 'in-realm', allowed: false },
    { mode: 'delegated', allowed: true },
    { mode: 'delegated', allowed: false }
  ])('GEO014 proxy $mode Swap feature allowed=$allowed after proof', async ({ mode, allowed }) => {
    const { TEST_BRIDGE_CONFIG_SNAPSHOT } = await import('lib/epoch/testing/bridge-config');
    const accepted = TEST_BRIDGE_CONFIG_SNAPSHOT.config;
    if (!accepted) throw new Error('Expected a configured Swap fixture');
    let featureAllowed = true;
    const snapshot = (): import('lib/remote-config/runtime').BridgeConfigSnapshot => ({
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: { ...accepted, geo: { swap: [{ country: 'US' }] } },
      geo: {
        state: 'ready',
        network: accepted.network,
        version: accepted.version,
        allowed: { wallet: true, earn: true, swap: featureAllowed }
      }
    });
    jest.doMock('lib/remote-config/runtime', () => ({
      getBridgeConfigSnapshot: snapshot,
      initBridgeConfig: async () => snapshot(),
      holdFastPoll: () => () => undefined,
      subscribeBridgeConfig: () => () => undefined
    }));
    const harness = buildHarness();
    harness.setWorkerProve(async () => {
      featureAllowed = allowed;
      harness.order.push('worker prove');
      return { proven: new Uint8Array([5, 5]), durationMs: 10 };
    });
    harness.inRealm.onLocalProve = () => {
      featureAllowed = allowed;
    };
    harness.delegated.onProve = () => {
      featureAllowed = allowed;
    };
    const { client } = await load(harness, mode === 'worker');
    const mutex = await import('./miden-client');
    const clientRead = jest.spyOn(mutex, 'getMidenClient').mockResolvedValue(client);
    const { midenClientProxy } = await import('../back/miden-client-proxy');
    const { hasErrorBeforeSubmit } = await import('./sdk-error-code');
    try {
      const outcome = await midenClientProxy
        .swapTransaction(
          swapTx(mode === 'delegated'),
          jest.fn(async () => new Uint8Array([2]))
        )
        .then(
          () => ({ ok: true, error: undefined }),
          (error: unknown) => ({ ok: false, error })
        );
      expect(harness.executeRequest).toHaveBeenCalledTimes(1);
      expect(featureAllowed).toBe(allowed);
      expect(snapshot().geo).toMatchObject({ allowed: { wallet: true } });
      expect(harness.order.filter(step => step === 'submitProven' || step.endsWith(' submit'))).toHaveLength(
        allowed ? 1 : 0
      );
      expect(harness.order.filter(step => step === 'apply')).toHaveLength(allowed ? 1 : 0);
      expect(outcome.ok).toBe(allowed);
      expect(hasErrorBeforeSubmit(outcome.error)).toBe(!allowed);
      expect(harness.transport.prove).toHaveBeenCalledTimes(mode === 'worker' ? 1 : 0);
      expect(mutex.isWasmClientBusy()).toBe(false);
    } finally {
      clientRead.mockRestore();
    }
  });
});
