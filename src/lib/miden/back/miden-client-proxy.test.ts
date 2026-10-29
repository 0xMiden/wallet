/* eslint-disable import/first */
/**
 * Tests for the SW-side `MidenClientProxy` (issue #260, slice 1).
 *
 * Coverage:
 *   - flag routing: OFF → inline `getMidenClient().getAccount`; ON → offscreen.
 *   - the OFFSCREEN_CALL envelope the proxy emits (target/type/op_id/method/
 *     argsB64/deadline_ms) and the serialize round-trip back to an Account.
 *   - the per-op deadline → closeDocument + reopen + reject-ALL-in-flight with
 *     OperationAbortedError.
 *   - the §4 downgrade: a real prove in flight turns a read deadline into a
 *     reject-without-kill (doc survives).
 *
 * The real `offscreen-prover` + `offscreen-codec` run against a hand-rolled
 * chrome.offscreen/runtime mock (mirroring offscreen-prover.test.ts). The SDK
 * (`Account`/`getWasmOrThrow`) and the inline `getMidenClient` are mocked via a
 * global `__px` control object so each branch is fully deterministic.
 */

const G = globalThis as any;

// Marks the file as a module so its top-level helpers stay file-scoped.
// eslint-disable-next-line jest/no-export
export {};

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const g = globalThis as any;
  return {
    getWasmOrThrow: (...a: any[]) => g.__px.getWasmOrThrow(...a),
    Address: {
      fromAccountId: (accountId: { canonical: string }) => ({ toBech32: () => accountId.canonical })
    },
    NetworkId: { testnet: () => 'testnet' },
    Account: { deserialize: (...a: any[]) => g.__px.accountDeserialize(...a) },
    NoteFile: { deserialize: (bytes: Uint8Array) => g.__px.retainedNoteFileDeserialize(bytes) },
    FeltArray: class {
      constructor(readonly elements: unknown[]) {}
    },
    Poseidon2: { hashElements: () => g.__px.retainedDetailsCommitment() },
    // Slice 5: the flag-on offscreen consume re-hydrates the serialized
    // TransactionResult on the SW side.
    TransactionResult: { deserialize: (...a: any[]) => g.__px.txResultDeserialize(...a) },
    // The inline dry run deserializes the request it executes.
    TransactionRequest: { deserialize: (...a: any[]) => g.__px.txRequestDeserialize(...a) }
  };
});

// The dry run's request preparation, which reads the account through the client, answered here.
jest.mock('lib/miden/sdk/custom-request', () => {
  const g = globalThis as any;
  return { prepareCustomRequestBytes: (...a: any[]) => g.__px.prepareCustomRequestBytes(...a) };
});

jest.mock('lib/miden/sdk/miden-client', () => {
  const g = globalThis as any;
  return {
    getMidenClient: (...a: any[]) => g.__px.getMidenClient(...a),
    getCurrentWasmLockHold: () => g.__px.inlineHold,
    assertWasmHoldCurrent: (hold: unknown) => {
      if (hold !== g.__px.inlineHold) throw new Error('hold replaced');
    },
    // The flag-off consume takes the CALLER lock itself (byte-identical to the
    // old switch-under-lock); route through the control so tests can assert it.
    withWasmClientLock: (...a: any[]) => g.__px.withWasmClientLock(...a)
  };
});

jest.mock('lib/miden/swap/fee-context', () => {
  const g = globalThis as any;
  return { readSwapFeeContext: (...a: any[]) => g.__px.readSwapFeeContext(...a) };
});

import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';

import { decodeArg } from './offscreen-codec';

// Use the REAL offscreen-prover (issue #260, slice 5): ensureOffscreenDocument /
// forceClose drive the chrome mock, and the criticalOp counters are the genuine
// module state the write path increments — so a "read deadline while a write is
// in flight" downgrade is exercised against real bookkeeping, not a stub.

type OnMessageListener = (msg: any, sender: any, sendResponse: (r?: any) => void) => boolean | undefined;
type WasmLockHold = import('lib/miden/sdk/miden-client').WasmLockHold;

let fakeChrome: any;
let docExists = false;

function installChromeMock(opts: { withOffscreen?: boolean } = {}) {
  const { withOffscreen = true } = opts;
  docExists = false;
  fakeChrome = {
    runtime: {
      sendMessage: jest.fn(),
      onMessage: {
        listeners: [] as OnMessageListener[],
        addListener: jest.fn((l: OnMessageListener) => {
          fakeChrome.runtime.onMessage.listeners.push(l);
        }),
        removeListener: jest.fn((l: OnMessageListener) => {
          fakeChrome.runtime.onMessage.listeners = fakeChrome.runtime.onMessage.listeners.filter(
            (x: OnMessageListener) => x !== l
          );
        })
      }
    }
  };
  if (withOffscreen) {
    fakeChrome.offscreen = {
      createDocument: jest.fn(async () => {
        docExists = true;
      }),
      closeDocument: jest.fn(async () => {
        docExists = false;
      }),
      hasDocument: jest.fn(async () => docExists),
      Reason: { WORKERS: 'WORKERS' }
    };
  }
  G.chrome = fakeChrome;
}

/** Resolve the reopen/open ready gate. */
function fireReady() {
  for (const l of fakeChrome.runtime.onMessage.listeners) l({ type: 'OFFSCREEN_READY' }, undefined, () => {});
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let ORIGINAL_FLAG: string | undefined;

function resetControl() {
  G.__px = {
    getWasmOrThrow: jest.fn(async () => ({})),
    accountDeserialize: jest.fn((bytes: Uint8Array) => ({ __account: Array.from(bytes) })),
    // Slice 5: rehydrate a serialized TransactionResult on the SW side.
    txResultDeserialize: jest.fn((bytes: Uint8Array) => ({ __txResult: Array.from(bytes) })),
    txRequestDeserialize: jest.fn((bytes: Uint8Array) => ({ __request: Array.from(bytes) })),
    prepareCustomRequestBytes: jest.fn(async (_client: unknown, _account: string, bytes: Uint8Array) => bytes),
    inlineGetAccount: jest.fn(async () => ({ __inlineAccount: true })),
    // The inline (flag-off) client also exposes the slice-3/4/5 methods so the
    // flag-off pass-through of each is assertable against a spy.
    inlineSyncState: jest.fn(async () => ({ __syncSummary: true, blockNum: () => 5000 })),
    // Slice 6b: the flag-off pass-through of the structural commit-wait.
    inlineWaitForTransactionCommit: jest.fn(async () => {}),
    // Slice 7b: the flag-off pass-through of the private-note relay.
    inlineSendPrivateNote: jest.fn(async () => {}),
    inlineRelayPrivateNoteById: jest.fn(async () => {}),
    inlineIsOutputNoteConsumed: jest.fn(async () => false),
    inlineExportNote: jest.fn(async () => new Uint8Array([1, 2, 3])),
    inlineGetInputNoteDetails: jest.fn(async () => [{ __inlineDetail: true }]),
    inlineGetDetailsCommitmentMatches: jest.fn(async () => [{ notes: [{ __inlineDetail: true }], uncommitted: 1 }]),
    inlineGetConsumableNoteDtos: jest.fn(async () => [{ __inlineConsumable: true }]),
    inlineBuildPswapCancelRequest: jest.fn(async () => new Uint8Array([20, 14, 7, 6])),
    inlineConsumeNoteId: jest.fn(async () => ({ __inlineTxResult: true })),
    // Slice 5b: the flag-off passthrough of each remaining non-guardian write.
    inlineSendTransaction: jest.fn(async () => ({ __inlineSendResult: true })),
    inlineSwapTransaction: jest.fn(async () => ({ __inlineSwapResult: true })),
    inlineNewTransaction: jest.fn(async () => ({ __inlineNewResult: true })),
    readSwapFeeContext: jest.fn(async (scope?: string) => ({
      scope: scope ?? 'testnet|default',
      nativeAssetId: 'mtst1qfee',
      feeFaucetId: null,
      baseFee: 7n
    })),
    // Slice 7a: the flag-off passthrough of the deferred reach-through reads. The
    // raw client (`.client`) exposes getSyncHeight / sync / pswap.lineage; the
    // interface exposes getInputNote / importNoteBytes. The live-record returns are
    // shaped exactly as the shared reducers read them.
    inlineGetSyncHeight: jest.fn(async () => 4242),
    inlineSync: jest.fn(async () => ({ blockNum: () => 5000 })),
    inlineLineage: jest.fn(async () => ({
      orderId: () => '77',
      currentTipNoteId: () => ({ toString: () => '0xtip' }),
      currentDepth: () => 2,
      state: () => 1,
      remainingOffered: () => 10n,
      remainingRequested: () => 20n
    })),
    inlineLineages: jest.fn(async () => [
      {
        orderId: () => '77',
        currentTipNoteId: () => ({ toString: () => '0xtip' }),
        currentDepth: () => 2,
        state: () => 1,
        remainingOffered: () => 9007199254740993n,
        remainingRequested: () => 20n
      },
      {
        orderId: () => '88',
        currentTipNoteId: () => ({ toString: () => '0xtip88' }),
        currentDepth: () => 0,
        state: () => 0,
        remainingOffered: () => 30n,
        remainingRequested: () => 40n
      }
    ]),
    inlineGetInputNote: jest.fn(async () => ({
      metadata: () => ({ noteType: () => 1 }),
      details: () => {
        throw new Error('note details unavailable');
      }
    })),
    inlineGetTransactionCommitState: jest.fn(async () => 'committed'),
    inlineImportNoteBytes: jest.fn(async () => '0ximportedid'),
    inlineDrainPrivateNoteTransport: jest.fn(async () => {}),
    inlineImportRecoveryNoteBytes: jest.fn(async () => ({ imported: 2, failures: 0 })),
    inlineRecoverPublicNotesRange: jest.fn(async () => ({ imported: 3, failures: 0 })),
    inlineResolveRecoveryScanRange: jest.fn(async () => ({ startBlock: 7, latestBlock: 99 })),
    inlineImportGuardianHistoryP2ideNotes: jest.fn(async () => undefined),
    inlineDecodeGuardianHistory: jest.fn(async () => ({ __inlineSummary: true })),
    inlineGetGuardianResultCommitment: jest.fn(async () => '0xinlinecommitment'),
    inlineHold: { mock: 'inline-hold' },
    // A real pass-through lock so the flag-off "caller lock preserved" assertion
    // is meaningful (spy call count) while still executing the wrapped op.
    withWasmClientLock: jest.fn(async (fn: (hold: unknown) => Promise<unknown>) => fn(G.__px.inlineHold)),
    getMidenClient: jest.fn(async () => ({
      getAccount: (...a: any[]) => G.__px.inlineGetAccount(...a),
      syncState: (...a: any[]) => G.__px.inlineSyncState(...a),
      waitForTransactionCommit: (...a: any[]) => G.__px.inlineWaitForTransactionCommit(...a),
      sendPrivateNote: (...a: any[]) => G.__px.inlineSendPrivateNote(...a),
      relayPrivateNoteById: (...a: any[]) => G.__px.inlineRelayPrivateNoteById(...a),
      isOutputNoteConsumed: (...a: any[]) => G.__px.inlineIsOutputNoteConsumed(...a),
      exportNote: (...a: any[]) => G.__px.inlineExportNote(...a),
      getInputNoteDetails: (...a: any[]) => G.__px.inlineGetInputNoteDetails(...a),
      getDetailsCommitmentMatches: (...a: any[]) => G.__px.inlineGetDetailsCommitmentMatches(...a),
      getTransactionCommitState: (...a: any[]) => G.__px.inlineGetTransactionCommitState(...a),
      getConsumableNoteDtos: (...a: any[]) => G.__px.inlineGetConsumableNoteDtos(...a),
      buildPswapCancelRequest: (...a: any[]) => G.__px.inlineBuildPswapCancelRequest(...a),
      consumeNoteId: (...a: any[]) => G.__px.inlineConsumeNoteId(...a),
      sendTransaction: (...a: any[]) => G.__px.inlineSendTransaction(...a),
      swapTransaction: (...a: any[]) => G.__px.inlineSwapTransaction(...a),
      newTransaction: (...a: any[]) => G.__px.inlineNewTransaction(...a),
      // Slice 7a: getInputNote / importNoteBytes are interface methods; the sync
      // height + pswap lineage are reached through the raw `.client`.
      getInputNote: (...a: any[]) => G.__px.inlineGetInputNote(...a),
      importNoteBytes: (...a: any[]) => G.__px.inlineImportNoteBytes(...a),
      drainPrivateNoteTransport: (...a: any[]) => G.__px.inlineDrainPrivateNoteTransport(...a),
      importRecoveryNoteBytes: (...a: any[]) => G.__px.inlineImportRecoveryNoteBytes(...a),
      recoverPublicNotesRange: (...a: any[]) => G.__px.inlineRecoverPublicNotesRange(...a),
      resolveRecoveryScanRange: (...a: any[]) => G.__px.inlineResolveRecoveryScanRange(...a),
      decodeGuardianHistory: (...a: any[]) => G.__px.inlineDecodeGuardianHistory(...a),
      importGuardianHistoryP2ideNotes: G.__px.inlineImportGuardianHistoryP2ideNotes,
      getGuardianResultCommitment: (...a: any[]) => G.__px.inlineGetGuardianResultCommitment(...a),
      client: {
        getSyncHeight: (...a: any[]) => G.__px.inlineGetSyncHeight(...a),
        sync: (...a: any[]) => G.__px.inlineSync(...a),
        pswap: {
          lineage: (orderId: string | bigint) => G.__px.inlineLineage(orderId),
          lineages: () => G.__px.inlineLineages()
        }
      }
    }))
  };
}

/**
 * Set the flag, reset module registry, and import a fresh proxy. The realm starts with nothing stored and,
 * unless `overridesLoaded` is false, has run its first override load, as start() does before any message
 * reaches the offscreen document (#1482).
 */
async function loadProxy(flagOn: boolean, { overridesLoaded = true }: { overridesLoaded?: boolean } = {}) {
  if (flagOn) process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
  else delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  jest.resetModules();
  const endpoints = await import('lib/miden-chain/effective-endpoints');
  await endpoints.clearEndpointOverride();
  if (overridesLoaded) await endpoints.loadEndpointOverrides();
  return import('./miden-client-proxy');
}

function tryReadAccount(proxy: object, accountId: string): Promise<unknown> {
  const method: unknown = Reflect.get(proxy, 'tryGetAccount');
  if (typeof method !== 'function') throw new Error('midenClientProxy.tryGetAccount is missing');
  return Promise.resolve(Reflect.apply(method, proxy, [accountId]));
}

beforeEach(() => {
  ORIGINAL_FLAG = process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  resetControl();
  installChromeMock();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  else process.env.MIDEN_USE_OFFSCREEN_CLIENT = ORIGINAL_FLAG;
  delete G.chrome;
});

describe('MidenClientProxy — flag routing', () => {
  it('the try-lock read reports busy without waiting', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify({ ran: false })).toString('base64'),
      durationMs: 0
    }));

    const read = tryReadAccount(midenClientProxy, 'busy-fee-account');
    await flush();
    fireReady();
    const result = await read;

    expect(result).toEqual({ ran: false });
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'tryGetAccount',
        argsB64: ['s:"busy-fee-account"'],
        deadline_ms: 15_000
      })
    );
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.accountDeserialize).not.toHaveBeenCalled();
  });

  it('the try-lock inline read runs under the caller hold', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const { withWasmClientLock, getCurrentWasmLockHold } = await import('lib/miden/sdk/miden-client');
    const account = { __inlineFeeAccount: true };
    let callerHold: unknown;
    let holdAtRead: unknown;
    G.__px.inlineGetAccount.mockImplementation(async () => {
      holdAtRead = getCurrentWasmLockHold();
      return account;
    });

    const result = await withWasmClientLock(async hold => {
      callerHold = hold;
      return tryReadAccount(midenClientProxy, 'inline-fee-account');
    });

    expect(result).toEqual({ ran: true, account });
    expect(holdAtRead).toBe(callerHold);
    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineGetAccount).toHaveBeenCalledWith('inline-fee-account');
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag OFF → getAccount goes inline (getMidenClient), never touches offscreen', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const result = await midenClientProxy.getAccount('acc-1');

    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineGetAccount).toHaveBeenCalledWith('acc-1');
    expect(result).toEqual({ __inlineAccount: true });
    // No offscreen doc created, no message sent, no rehydrate.
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(G.__px.accountDeserialize).not.toHaveBeenCalled();
  });

  it('flag ON but no chrome.offscreen API → falls back inline', async () => {
    installChromeMock({ withOffscreen: false });
    const { midenClientProxy } = await loadProxy(true);
    const result = await midenClientProxy.getAccount('acc-2');

    expect(G.__px.inlineGetAccount).toHaveBeenCalledWith('acc-2');
    expect(result).toEqual({ __inlineAccount: true });
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → getAccount routes through the offscreen proxy and rehydrates the Account', async () => {
    const { midenClientProxy } = await loadProxy(true);
    // Offscreen echoes op_id + returns serialized [7,7,7] bytes.
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from([7, 7, 7]).toString('base64'),
      durationMs: 3
    }));

    const p = midenClientProxy.getAccount('acc-3');
    await flush();
    fireReady(); // let ensureOffscreenDocument resolve
    const account = await p;

    // Never used the inline client.
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    // Emitted exactly one OFFSCREEN_CALL envelope with the right shape.
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.target).toBe('offscreen');
    expect(env.type).toBe('OFFSCREEN_CALL');
    expect(typeof env.op_id).toBe('string');
    expect(env.method).toBe('getAccount');
    expect(env.deadline_ms).toBe(15_000);
    expect(env.argsB64).toEqual(['s:"acc-3"']); // encodeArg('acc-3')
    // Rehydrated via Account.deserialize on the SW side, WASM ensured first.
    expect(G.__px.getWasmOrThrow).toHaveBeenCalledTimes(1);
    expect(G.__px.accountDeserialize).toHaveBeenCalledTimes(1);
    expect(account).toEqual({ __account: [7, 7, 7] });
  });

  it('flag ON → getAccount returns null when the offscreen result is null (no rehydrate)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.getAccount('missing');
    await flush();
    fireReady();
    const account = await p;

    expect(account).toBeNull();
    expect(G.__px.accountDeserialize).not.toHaveBeenCalled();
  });

  it('flag ON → an ok:false offscreen response rejects the caller', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: false,
      op_id: env.op_id,
      error: 'boom in offscreen'
    }));

    const p = midenClientProxy.getAccount('acc').catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('boom in offscreen');
  });

  it('routes pending-note recovery chunks inline when the offscreen client is disabled', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const noteBytes = [new Uint8Array([1, 2]), new Uint8Array([3])];

    await midenClientProxy.drainPrivateNoteTransport();
    const imported = await midenClientProxy.importRecoveryNoteBytes(noteBytes);
    const scanRange = await midenClientProxy.resolveRecoveryScanRange(1_700_000_000);
    const publicCount = await midenClientProxy.recoverPublicNotesRange('mtst1guardian', 100, 200);

    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(4);
    expect(G.__px.inlineDrainPrivateNoteTransport).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineImportRecoveryNoteBytes).toHaveBeenCalledWith(noteBytes, G.__px.inlineHold);
    expect(G.__px.inlineResolveRecoveryScanRange).toHaveBeenCalledWith(1_700_000_000);
    expect(G.__px.inlineRecoverPublicNotesRange).toHaveBeenCalledWith('mtst1guardian', 100, 200, 0);
    expect(imported).toEqual({ imported: 2, failures: 0 });
    expect(scanRange).toEqual({ startBlock: 7, latestBlock: 99 });
    expect(publicCount).toEqual({ imported: 3, failures: 0 });
  });

  it('routes proposal-note import through offscreen and preserves note bytes', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const sdkResult = { imported: 1, failures: 0 };
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify(sdkResult)).toString('base64'),
      durationMs: 2
    }));

    const pending = midenClientProxy.importRecoveryNoteBytes([new Uint8Array([7, 8, 9])]);
    await flush();
    fireReady();
    const result = await pending;

    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('importRecoveryNoteBytes');
    expect(env.deadline_ms).toBe(60_000);
    expect(env.argsB64).toEqual([`s:["${Buffer.from([7, 8, 9]).toString('base64')}"]`]);
    expect(result).toEqual(sdkResult);
  });

  it('routes one public-backfill range through offscreen with its bounds', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify({ imported: 5, failures: 1, saturated: false })).toString('base64'),
      durationMs: 2
    }));

    const pending = midenClientProxy.recoverPublicNotesRange('mtst1guardian', 1_000, 200_999);
    await flush();
    fireReady();
    const result = await pending;

    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('recoverPublicNotesRange');
    expect(env.deadline_ms).toBe(60_000);
    expect(env.argsB64).toEqual(['s:"mtst1guardian"', 's:1000', 's:200999', 's:0']);
    expect(result).toEqual({ imported: 5, failures: 1, saturated: false, nextNoteOffset: undefined });
  });

  it('carries the note page offset and the cursor back over the boundary', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(
        JSON.stringify({ imported: 200, failures: 0, saturated: false, nextNoteOffset: 400 })
      ).toString('base64'),
      durationMs: 2
    }));

    const pending = midenClientProxy.recoverPublicNotesRange('mtst1guardian', 1_000, 1_999, 200);
    await flush();
    fireReady();
    const result = await pending;

    expect(fakeChrome.runtime.sendMessage.mock.calls[0][0].argsB64).toEqual([
      's:"mtst1guardian"',
      's:1000',
      's:1999',
      's:200'
    ]);
    expect(result).toEqual({ imported: 200, failures: 0, saturated: false, nextNoteOffset: 400 });
  });

  // Like `saturated`, the cursor re-offers the same range, so a value that is
  // not a usable index has to throw rather than be coerced into one.
  it.each([['not-a-number'], [-1], [1.5]])('rejects a malformed nextNoteOffset (%s)', async nextNoteOffset => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify({ imported: 0, failures: 0, saturated: false, nextNoteOffset })).toString(
        'base64'
      ),
      durationMs: 2
    }));

    const pending = midenClientProxy.recoverPublicNotesRange('mtst1guardian', 1_000, 200_999);
    await flush();
    fireReady();

    await expect(pending).rejects.toThrow('malformed nextNoteOffset');
  });

  // `saturated` drives the caller's split loop, so a truthy non-boolean would
  // make it split forever instead of failing the chunk.
  it('rejects a non-boolean saturated from the offscreen document', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify({ imported: 0, failures: 0, saturated: 'yes' })).toString('base64'),
      durationMs: 2
    }));

    const pending = midenClientProxy.recoverPublicNotesRange('mtst1guardian', 1_000, 200_999);
    await flush();
    fireReady();

    await expect(pending).rejects.toThrow('malformed saturated');
  });

  it('routes the scan-range resolution through offscreen with its created-at seconds', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify({ startBlock: 1_000, latestBlock: 250_000 })).toString('base64'),
      durationMs: 2
    }));

    const pending = midenClientProxy.resolveRecoveryScanRange(1_700_000_000);
    await flush();
    fireReady();
    const result = await pending;

    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('resolveRecoveryScanRange');
    expect(env.deadline_ms).toBe(60_000);
    expect(env.argsB64).toEqual(['s:1700000000']);
    expect(result).toEqual({ startBlock: 1_000, latestBlock: 250_000 });
  });

  // A missing `failures` would make the orchestrator's accumulator NaN, and
  // `NaN > 0` is false — reading as a clean pass over a chunk that reported
  // nothing, which clears the one-shot recovery flag.
  it.each([
    ['a missing count', { imported: 4 }],
    ['a non-numeric count', { imported: 4, failures: 'none' }],
    ['a negative count', { imported: 4, failures: -1 }]
  ])('rejects a recovery chunk payload with %s', async (_label, payload) => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify(payload)).toString('base64'),
      durationMs: 2
    }));

    const pending = midenClientProxy.recoverPublicNotesRange('mtst1guardian', 0, 10);
    await flush();
    fireReady();

    await expect(pending).rejects.toThrow('malformed failures');
  });
});

describe('MidenClientProxy — slice-3 reads: syncState', () => {
  it('flag OFF → syncState goes inline (getMidenClient), never touches offscreen', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const result = await midenClientProxy.syncState();

    expect(G.__px.inlineSyncState).toHaveBeenCalledTimes(1);
    // The SyncSummary the inline client returns is discarded — resolves void.
    expect(result).toBeUndefined();
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → syncState dispatches OFFSCREEN_CALL with the sync deadline + empty args, resolves void', async () => {
    const { midenClientProxy } = await loadProxy(true);
    // Offscreen runs the sync and returns a null result (SyncSummary discarded).
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 12
    }));

    const p = midenClientProxy.syncState();
    await flush();
    fireReady();
    const result = await p;

    expect(result).toBeUndefined();
    // Inline client untouched.
    expect(G.__px.inlineSyncState).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.type).toBe('OFFSCREEN_CALL');
    expect(env.method).toBe('syncState');
    expect(env.argsB64).toEqual([]);
    // Sync's backstop deadline sits above the caller's own 30s SYNC_TIMEOUT.
    expect(env.deadline_ms).toBe(45_000);
  });
});

describe('MidenClientProxy — slice-6b waitForTransactionCommit (structural commit-wait)', () => {
  it('flag OFF → waitForTransactionCommit runs inline under withWasmClientLock (byte-identical), never touches offscreen', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const result = await midenClientProxy.waitForTransactionCommit('0xtxid');

    // The caller lock wraps the op (exactly the block the structural completion path
    // ran before this fix pulled it into the proxy).
    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    // Polled the SW inline client — the one that applied the tx flag-off.
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineWaitForTransactionCommit).toHaveBeenCalledWith('0xtxid');
    expect(result).toBeUndefined();
    // Offscreen never touched.
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON but no chrome.offscreen API → waitForTransactionCommit falls back inline', async () => {
    installChromeMock({ withOffscreen: false });
    const { midenClientProxy } = await loadProxy(true);
    await midenClientProxy.waitForTransactionCommit('0xtxid');

    expect(G.__px.inlineWaitForTransactionCommit).toHaveBeenCalledWith('0xtxid');
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → dispatches OFFSCREEN_CALL to the realm that applied the tx (150s deadline), never the dormant SW client', async () => {
    const { midenClientProxy } = await loadProxy(true);
    // The offscreen side runs the SDK waitFor and returns null (void discarded).
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 12
    }));

    const p = midenClientProxy.waitForTransactionCommit('0xtxid');
    await flush();
    fireReady();
    const result = await p;

    expect(result).toBeUndefined();
    // THE FIX: the wait crossed to the offscreen realm (which owns the applied state);
    // the raw SW client — dormant/unsynced flag-on — was NEVER polled, so it can't
    // time out at ~60s and strand the structural completion.
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.inlineWaitForTransactionCommit).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.type).toBe('OFFSCREEN_CALL');
    expect(env.method).toBe('waitForTransactionCommit');
    expect(env.argsB64).toEqual(['s:"0xtxid"']); // encodeArg('0xtxid')
    // A commit-wait blocks up to the ~60s poll window AND now yields the offscreen
    // mutex during its sleeps (follow-up #1), so its wall-clock can absorb other ops'
    // mutex-holds — its deadline sits well ABOVE 60s (150s), NOT a read's short 15s.
    expect(env.deadline_ms).toBe(150_000);
  });

  it('flag ON → a deadline kill rejects with OperationAbortedError (parity with flag-off waitFor timeout → Failed)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    // The offscreen wait never responds → only the deadline can end it. Use the
    // generic `call` with a short deadline to exercise the same kill path without
    // waiting the production 150s (the routing test above pins the real 150s value).
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const p = midenClientProxy.call('waitForTransactionCommit', ['0xtxid'], { deadlineMs: 20 }).catch((e: Error) => e);
    await flush();
    fireReady();
    await flush();
    await wait(40);
    fireReady();
    await flush();

    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('deadline');
  });
});

describe('MidenClientProxy — slice-7b sendPrivateNote (private-note relay)', () => {
  // A live-Note stand-in: exposes serialize() (the flag-ON path crosses these bytes)
  // and is passed straight through on the flag-OFF path (never serialized there).
  const makeNote = (bytes: number[]) => ({ serialize: () => new Uint8Array(bytes) });

  it('flag OFF → sendPrivateNote runs inline under withWasmClientLock on the SW client (byte-identical), never serializes, never touches offscreen', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const note = makeNote([9, 9]);
    const serializeSpy = jest.spyOn(note, 'serialize');

    const result = await midenClientProxy.sendPrivateNote(note as any, 'mtst1qrecipient');

    // Caller lock wraps the relay — exactly the block the completion path ran before
    // this slice pulled it into the proxy.
    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    // Relayed on the SW inline client — the one that created the note flag-off.
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    // The user's own relay keeps its default hold: it is not a timer-driven probe.
    expect(G.__px.withWasmClientLock.mock.calls[0]).toHaveLength(1);
    // The LIVE note object crossed straight through — never serialized on this path.
    expect(G.__px.inlineSendPrivateNote).toHaveBeenCalledWith(note, 'mtst1qrecipient');
    expect(serializeSpy).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    // Offscreen never touched.
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON but no chrome.offscreen API → sendPrivateNote falls back inline', async () => {
    installChromeMock({ withOffscreen: false });
    const { midenClientProxy } = await loadProxy(true);
    const note = makeNote([1]);

    await midenClientProxy.sendPrivateNote(note as any, 'mtst1qrecipient');

    expect(G.__px.inlineSendPrivateNote).toHaveBeenCalledWith(note, 'mtst1qrecipient');
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → sendPrivateNote still relays on the SW client (offscreen fetch to 127.0.0.1 is CORS-blocked)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const note = makeNote([0xde, 0xad, 0xbe, 0xef]);

    const result = await midenClientProxy.sendPrivateNote(note as any, 'mtst1qrecipient');

    expect(result).toBeUndefined();
    expect(G.__px.inlineSendPrivateNote).toHaveBeenCalledWith(note, 'mtst1qrecipient');
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → relayPrivateNoteById re-pushes on the SW client under withWasmClientLock, as sendPrivateNote relays', async () => {
    // The sweep's re-push runs where the original relay runs. Offscreen fetch to a
    // localnet transport is CORS-blocked, and the SW client resolves the output note
    // the offscreen client applied.
    const { midenClientProxy } = await loadProxy(true);

    const result = await midenClientProxy.relayPrivateNoteById('0xnote', 'mtst1qrecipient');

    expect(result).toBeUndefined();
    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    // An unattended hold, so bounded at the sync ceiling and named in any eviction record.
    expect(G.__px.withWasmClientLock).toHaveBeenCalledWith(expect.any(Function), {
      watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
      label: 'note-delivery-push'
    });
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineRelayPrivateNoteById).toHaveBeenCalledWith('0xnote', 'mtst1qrecipient');
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → isOutputNoteConsumed is a plain read and decodes the boolean', async () => {
    // The delivery receipt. A read, not a critical op: losing it costs one sweep
    // cycle, and the sweep's fallback ("not proven delivered") is the safe answer.
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from('true').toString('base64'),
      durationMs: 1
    }));

    const p = midenClientProxy.isOutputNoteConsumed('0xnote');
    await flush();
    fireReady();

    expect(await p).toBe(true);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('isOutputNoteConsumed');
    expect(env.deadline_ms).toBe(15_000);
  });

  it('flag ON → an empty receipt result reads as not-consumed rather than throwing', async () => {
    // A missing result must not wedge the sweep: it re-pushes, which is harmless.
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.isOutputNoteConsumed('0xnote');
    await flush();
    fireReady();

    expect(await p).toBe(false);
  });

  it('flag OFF → both sweep calls run inline on the SW client under the WASM lock', async () => {
    const { midenClientProxy } = await loadProxy(false);
    G.__px.inlineIsOutputNoteConsumed.mockResolvedValueOnce(true);

    expect(await midenClientProxy.isOutputNoteConsumed('0xnote')).toBe(true);
    await midenClientProxy.relayPrivateNoteById('0xnote', 'mtst1qrecipient');

    expect(G.__px.inlineIsOutputNoteConsumed).toHaveBeenCalledWith('0xnote');
    expect(G.__px.inlineRelayPrivateNoteById).toHaveBeenCalledWith('0xnote', 'mtst1qrecipient');
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(G.__px.withWasmClientLock.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'note-delivery-receipt' },
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'note-delivery-push' }
    ]);
  });

  it('flag ON → a deadline kill rejects with OperationAbortedError (caught by the completion relay → Completed, degraded)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    // The offscreen relay never responds → only the deadline can end it. Use the
    // generic `call` with a short deadline to exercise the same kill path.
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const p = midenClientProxy
      .call('sendPrivateNote', [new Uint8Array([1]), 'to'], { deadlineMs: 20 })
      .catch((e: Error) => e);
    await flush();
    fireReady();
    await flush();
    await wait(40);
    fireReady();
    await flush();

    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('deadline');
  });
});

describe('MidenClientProxy — the assertLive liveness check on the INLINE path', () => {
  // These three reads reach through to a live SDK object BETWEEN two of their own
  // awaits, so the only place the ownership re-check can go is inside the
  // interface method. Threading it through the proxy is what makes that check
  // reachable at all on mobile, desktop, Firefox and every flag-off build — with
  // the parameter dropped here it existed solely for the offscreen dispatch, and
  // the shipping paths ran unguarded.
  it('flag OFF → forwards the caller check into each of the three reads', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const assertLive = jest.fn();

    await midenClientProxy.exportNote('note-1', 'Details' as any, assertLive);
    await midenClientProxy.getInputNoteDetails({ ids: ['n1'] } as any, assertLive);
    await midenClientProxy.getConsumableNotes('acc-1', assertLive);

    expect(G.__px.inlineExportNote).toHaveBeenCalledWith('note-1', 'Details', assertLive);
    expect(G.__px.inlineGetInputNoteDetails).toHaveBeenCalledWith({ ids: ['n1'] }, assertLive);
    expect(G.__px.inlineGetConsumableNoteDtos).toHaveBeenCalledWith('acc-1', assertLive);
  });

  it('flag ON → does NOT try to send the check over the wire', async () => {
    // It cannot be serialized, and it must not be: under the flag the
    // reach-through happens in the offscreen realm under the OFFSCREEN hold, and
    // that dispatch injects its own check. The caller's hold is the wrong hold to
    // ask about there.
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from([1]).toString('base64'),
      durationMs: 1
    }));
    const assertLive = jest.fn();

    const p = midenClientProxy.exportNote('note-2', 'Details' as any, assertLive);
    await flush();
    fireReady();
    await p;

    const [envelope] = fakeChrome.runtime.sendMessage.mock.calls[0];
    // The two real arguments and nothing else — a third slot here would be an
    // un-JSON-able function tagged onto the wire.
    expect(envelope.argsB64).toEqual(['s:"note-2"', 's:"Details"']);
    expect(assertLive).not.toHaveBeenCalled();
  });
});

describe('MidenClientProxy — slice-3 reads: exportNote', () => {
  it('flag OFF → exportNote goes inline and returns the raw bytes', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const bytes = await midenClientProxy.exportNote('note-1', 'Details' as any);

    expect(G.__px.inlineExportNote).toHaveBeenCalledWith('note-1', 'Details', undefined);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → exportNote round-trips the serialized note bytes back verbatim', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from([9, 8, 7, 6]).toString('base64'),
      durationMs: 4
    }));

    const p = midenClientProxy.exportNote('note-2', 'Details' as any);
    await flush();
    fireReady();
    const bytes = await p;

    expect(G.__px.inlineExportNote).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('exportNote');
    expect(env.deadline_ms).toBe(15_000);
    // Args cross the wire: noteId + the (string-enum) export type, both JSON-tagged.
    expect(env.argsB64).toEqual(['s:"note-2"', 's:"Details"']);
    // Bytes came back intact (no re-hydration — the caller wants raw bytes).
    expect(Array.from(bytes)).toEqual([9, 8, 7, 6]);
  });

  it('flag ON → a null offscreen result throws (exportNote must always yield bytes)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.exportNote('note-3', 'Details' as any).catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('returned no bytes');
  });
});

describe('MidenClientProxy — slice-3 reads: getInputNoteDetails (plain-DTO round-trip)', () => {
  it('flag OFF → getInputNoteDetails goes inline, forwarding the query', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const details = await midenClientProxy.getInputNoteDetails({ ids: ['n1'] } as any);

    expect(G.__px.inlineGetInputNoteDetails).toHaveBeenCalledWith({ ids: ['n1'] }, undefined);
    expect(details).toEqual([{ __inlineDetail: true }]);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → the DTO array survives JSON→bytes→base64→JSON round-trip intact', async () => {
    const { midenClientProxy } = await loadProxy(true);
    // A representative DTO: NUMERIC NoteType/InputNoteState enums (0/2) plus
    // string ids/assets — exactly the InputNoteDetails shape. This is the whole
    // reason getInputNoteDetails CAN move while getConsumableNotes cannot: the
    // interface already reduced the live InputNoteRecord to plain JSON.
    const dto = [
      {
        noteId: '0xabc',
        senderAccountId: 'mtst1qsender',
        assets: [{ amount: '100', faucetId: 'mtst1qfaucet' }],
        noteType: 0,
        nullifier: '0xnull',
        state: 2
      }
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(dto));
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(bytes).toString('base64'),
      durationMs: 6
    }));

    const p = midenClientProxy.getInputNoteDetails({ ids: ['0xabc'] } as any);
    await flush();
    fireReady();
    const details = await p;

    expect(G.__px.inlineGetInputNoteDetails).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('getInputNoteDetails');
    // Query arg JSON-tagged across the wire.
    expect(env.argsB64).toEqual(['s:{"ids":["0xabc"]}']);
    // The parsed DTO is deep-equal to what the offscreen side produced — the
    // numeric enums and nested asset strings all survived.
    expect(details).toEqual(dto);
  });

  it('flag ON → an undefined query round-trips as JSON null and an empty result → []', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode('[]')).toString('base64'),
      durationMs: 2
    }));

    const p = midenClientProxy.getInputNoteDetails();
    await flush();
    fireReady();
    const details = await p;

    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    // `undefined` arg is JSON-null on the wire (decodeArg → null → `?? undefined`).
    expect(env.argsB64).toEqual(['s:null']);
    expect(details).toEqual([]);
  });
});

// The records a details commitment names, read where the store lives (#1389).
describe('MidenClientProxy - getDetailsCommitmentMatches', () => {
  it('forwards a batch inline with its liveness check and preserves entry order', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const assertLive = jest.fn();
    const dto = [
      { notes: [{ noteId: 'n9' }], uncommitted: 0 },
      { notes: [], uncommitted: 1 }
    ];
    G.__px.inlineGetDetailsCommitmentMatches.mockResolvedValueOnce(dto);

    await expect(
      midenClientProxy.getDetailsCommitmentMatches(['0xcommitment', '0xother'], ['n9', 'n10'], assertLive)
    ).resolves.toEqual(dto);

    expect(G.__px.inlineGetDetailsCommitmentMatches).toHaveBeenCalledWith(
      ['0xcommitment', '0xother'],
      ['n9', 'n10'],
      assertLive
    );
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('forwards a batch offscreen and decodes each result in order', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const dto = [
      { notes: [{ noteId: 'n9' }], uncommitted: 0 },
      { notes: [], uncommitted: 1 }
    ];
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify(dto)).toString('base64'),
      durationMs: 1
    }));

    const pending = midenClientProxy.getDetailsCommitmentMatches(['0xcommitment', '0xother'], ['n9', 'n10']);
    await flush();
    fireReady();

    await expect(pending).resolves.toEqual(dto);
    expect(fakeChrome.runtime.sendMessage.mock.calls[0][0].argsB64).toEqual([
      's:["0xcommitment","0xother"]',
      's:["n9","n10"]'
    ]);
  });

  it('returns one empty entry per requested commitment for a null offscreen reply', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const pending = midenClientProxy.getDetailsCommitmentMatches(['0xcommitment', '0xother'], []);
    await flush();
    fireReady();

    await expect(pending).resolves.toEqual([
      { notes: [], uncommitted: 0 },
      { notes: [], uncommitted: 0 }
    ]);
  });

  it('flag OFF goes inline, forwarding the commitment and the caller check', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const assertLive = jest.fn();

    const matches = await midenClientProxy.getDetailsCommitmentMatches(['0xcommitment'], ['n9'], assertLive);

    expect(G.__px.inlineGetDetailsCommitmentMatches).toHaveBeenCalledWith(['0xcommitment'], ['n9'], assertLive);
    expect(matches).toEqual([{ notes: [{ __inlineDetail: true }], uncommitted: 1 }]);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON asks the offscreen client and parses the DTO it answers', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const dto = [
      {
        notes: [
          { noteId: '0xreal', senderAccountId: 'mtst1qsender', assets: [], noteType: 0, nullifier: '0xn', state: 2 }
        ],
        uncommitted: 1
      }
    ];
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify(dto))).toString('base64'),
      durationMs: 3
    }));

    const p = midenClientProxy.getDetailsCommitmentMatches(['0xcommitment'], ['0xreal'], jest.fn());
    await flush();
    fireReady();
    const matches = await p;

    expect(G.__px.inlineGetDetailsCommitmentMatches).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('getDetailsCommitmentMatches');
    expect(env.argsB64).toEqual(['s:["0xcommitment"]', 's:["0xreal"]']);
    expect(matches).toEqual(dto);
  });

  it('flag ON reads no result as no match', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.getDetailsCommitmentMatches(['0xcommitment'], []);
    await flush();
    fireReady();

    await expect(p).resolves.toEqual([{ notes: [], uncommitted: 0 }]);
  });
});

/**
 * This read backs the send/swap idempotent-retry guard, and it used to be a
 * hardcoded 'not-found' whenever the flag was on — which is the DEFAULT in the
 * service worker. 'not-found' is not a safe placeholder: `verifySendLanded` maps
 * it to 'unknown', its "cannot prove it landed" verdict, and the retry proceeds
 * on that. So the only path that shipped was the one where the guard could never
 * fire, and a Failed row whose submit had landed was resubmitted — paying twice.
 */
describe('MidenClientProxy — getTransactionCommitState (retry double-send guard)', () => {
  it('flag OFF → goes inline, forwarding the tx id', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const state = await midenClientProxy.getTransactionCommitState('0xtxid');

    expect(G.__px.inlineGetTransactionCommitState).toHaveBeenCalledWith('0xtxid');
    expect(state).toBe('committed');
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['committed', 'pending', 'not-found'] as const)(
    'flag ON → dispatches and returns %p verbatim',
    async expected => {
      const { midenClientProxy } = await loadProxy(true);
      fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
        ok: true,
        op_id: env.op_id,
        resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify(expected))).toString('base64'),
        durationMs: 3
      }));

      const p = midenClientProxy.getTransactionCommitState('0xtxid');
      await flush();
      fireReady();
      const state = await p;

      expect(G.__px.inlineGetTransactionCommitState).not.toHaveBeenCalled();
      const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
      expect(env.method).toBe('getTransactionCommitState');
      expect(env.argsB64).toEqual(['s:"0xtxid"']);
      expect(state).toBe(expected);
    }
  );

  it('flag ON → an empty dispatch result THROWS rather than reporting a state nobody checked', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.getTransactionCommitState('0xtxid');
    await flush();
    fireReady();

    // The caller's catch turns a throw into the same conservative 'unknown', but
    // it also logs — where a fabricated 'not-found' was silent.
    await expect(p).rejects.toThrow(/getTransactionCommitState/);
  });
});

describe('MidenClientProxy — slice-4 consumable notes (DTO round-trip)', () => {
  it('flag OFF → getConsumableNotes goes inline via getConsumableNoteDtos (the reducing form)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const notes = await midenClientProxy.getConsumableNotes('acc-1');

    // Flag-off routes to the DTO-reducing interface method, NOT the raw
    // getConsumableNotes — so the reclaim gate + reduction run inline, exactly
    // as before this slice (just relocated into one place).
    expect(G.__px.inlineGetConsumableNoteDtos).toHaveBeenCalledWith('acc-1', undefined);
    expect(notes).toEqual([{ __inlineConsumable: true }]);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → getConsumableNotes routes offscreen and JSON-parses the DTO array back', async () => {
    const { midenClientProxy } = await loadProxy(true);
    // The offscreen side runs the reclaim gate against ITS OWN (sync-running)
    // realm's height and ships a reduced DTO array as UTF-8 JSON.
    const dto = [
      {
        noteId: '0xnote',
        nullifier: '0xnull',
        noteType: 1,
        senderAccountId: 'mtst1qsender',
        state: 2,
        assets: [{ amount: '100', faucetId: 'mtst1qfaucet' }],
        swapAttachment: { orderId: '77', depth: 2 }
      }
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(dto));
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(bytes).toString('base64'),
      durationMs: 7
    }));

    const p = midenClientProxy.getConsumableNotes('acc-2');
    await flush();
    fireReady();
    const notes = await p;

    // Inline reducing form untouched.
    expect(G.__px.inlineGetConsumableNoteDtos).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('getConsumableNotes');
    expect(env.deadline_ms).toBe(15_000);
    expect(env.argsB64).toEqual(['s:"acc-2"']);
    // Full DTO survived JSON→bytes→base64→JSON, swapAttachment + numeric enums intact.
    expect(notes).toEqual(dto);
  });

  it('flag ON → a null offscreen result yields an empty DTO array', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.getConsumableNotes('acc-3');
    await flush();
    fireReady();
    expect(await p).toEqual([]);
  });
});

describe('MidenClientProxy — zero-fill PSWAP cancel request', () => {
  it('flag OFF builds in the inline canonical client and forwards the hold check', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const assertLive = jest.fn();

    await expect(midenClientProxy.buildPswapCancelRequest('acc-1', 'tip-1', assertLive)).resolves.toEqual(
      new Uint8Array([20, 14, 7, 6])
    );

    // One call with the flag, false for a live order (#1487).
    expect(G.__px.inlineBuildPswapCancelRequest).toHaveBeenCalledWith('acc-1', 'tip-1', assertLive, {
      allowNodeNote: false
    });
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON returns the offscreen-built request bytes verbatim', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const bytes = new Uint8Array([20, 14, 7, 6]);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(bytes).toString('base64'),
      durationMs: 4
    }));

    const pending = midenClientProxy.buildPswapCancelRequest('acc-2', 'tip-2');
    await flush();
    fireReady();

    await expect(pending).resolves.toEqual(bytes);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('buildPswapCancelRequest');
    expect(env.argsB64).toEqual(['s:"acc-2"', 's:"tip-2"', 's:false']);
    expect(env.deadline_ms).toBe(15_000);
    expect(G.__px.inlineBuildPswapCancelRequest).not.toHaveBeenCalled();
  });

  // A recovered order's note exists only on the node (#1487).
  it('flag OFF forwards the node-note option to the inline client', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const assertLive = jest.fn();

    await midenClientProxy.buildPswapCancelRequest('acc-1', 'tip-1', assertLive, { allowNodeNote: true });

    expect(G.__px.inlineBuildPswapCancelRequest).toHaveBeenCalledWith('acc-1', 'tip-1', assertLive, {
      allowNodeNote: true
    });
  });

  it('flag ON sends the node-note option, with room in the deadline for its two node reads', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const bytes = new Uint8Array([9, 9]);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(bytes).toString('base64'),
      durationMs: 4
    }));

    const pending = midenClientProxy.buildPswapCancelRequest('acc-2', 'tip-2', undefined, { allowNodeNote: true });
    await flush();
    fireReady();

    await expect(pending).resolves.toEqual(bytes);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.argsB64).toEqual(['s:"acc-2"', 's:"tip-2"', 's:true']);
    expect(env.deadline_ms).toBe(25_000);
  });

  it('flag ON refuses a missing request payload', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const pending = midenClientProxy.buildPswapCancelRequest('acc-3', 'tip-3');
    await flush();
    fireReady();

    await expect(pending).rejects.toThrow('returned no request bytes');
  });
});

describe('MidenClientProxy — slice-7a reach-through reads', () => {
  // ── getSyncHeight ─────────────────────────────────────────────────────────
  it('flag OFF → getSyncHeight() reads the inline client height verbatim (no sync)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const height = await midenClientProxy.getSyncHeight();

    expect(G.__px.inlineGetSyncHeight).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineSync).not.toHaveBeenCalled();
    expect(height).toBe(4242);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag OFF → getSyncHeight({ fresh:true }) runs the inline network sync + reads blockNum (byte-identical)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const height = await midenClientProxy.getSyncHeight({ fresh: true });

    expect(G.__px.inlineSyncState).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineSync).not.toHaveBeenCalled();
    expect(G.__px.inlineGetSyncHeight).not.toHaveBeenCalled();
    expect(height).toBe(5000);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses to sync after inline client acquisition outlives its hold', async () => {
    const { midenClientProxy } = await loadProxy(false);
    let release: (client: unknown) => void = () => undefined;
    G.__px.getMidenClient.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const height = midenClientProxy.getSyncHeight({ fresh: true });
    G.__px.inlineHold = { replacement: true };
    release({ syncState: G.__px.inlineSyncState });
    await expect(height).rejects.toThrow('hold replaced');
    expect(G.__px.inlineSyncState).not.toHaveBeenCalled();
  });

  it('does not read a borrowed height summary after its sync lost the hold', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const blockNum = jest.fn(() => 5000);
    G.__px.inlineSyncState.mockImplementationOnce(async () => {
      G.__px.inlineHold = { replacement: true };
      return { blockNum };
    });
    await expect(midenClientProxy.getSyncHeight({ fresh: true })).rejects.toThrow('hold replaced');
    expect(blockNum).not.toHaveBeenCalled();
  });

  it('flag ON → getSyncHeight() dispatches with the read deadline + fresh:false and parses the number', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify(4242))).toString('base64'),
      durationMs: 2
    }));

    const p = midenClientProxy.getSyncHeight();
    await flush();
    fireReady();
    const height = await p;

    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('getSyncHeight');
    expect(env.deadline_ms).toBe(15_000);
    expect(env.argsB64).toEqual(['s:false']);
    expect(height).toBe(4242);
  });

  it('flag ON → getSyncHeight({ fresh:true }) carries the SYNC backstop deadline + fresh:true', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify(5000))).toString('base64'),
      durationMs: 12
    }));

    const p = midenClientProxy.getSyncHeight({ fresh: true });
    await flush();
    fireReady();
    const height = await p;

    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('getSyncHeight');
    // A fresh read runs a network sync → the 45s sync backstop, not the 15s read one.
    expect(env.deadline_ms).toBe(45_000);
    expect(env.argsB64).toEqual(['s:true']);
    expect(height).toBe(5000);
  });

  it('flag ON → a null getSyncHeight result throws (height must always come back)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.getSyncHeight().catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('returned no height');
  });

  // ── getPswapLineage ───────────────────────────────────────────────────────
  it('flag OFF → getPswapLineage reduces the inline live PswapLineageRecord to a DTO', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const dto = await midenClientProxy.getPswapLineage('77');

    expect(G.__px.inlineLineage).toHaveBeenCalledWith('77');
    // The shared reducer read every field the two callers use, BigInts → strings.
    expect(dto).toEqual({
      orderId: '77',
      currentTipNoteId: '0xtip',
      currentDepth: 2,
      state: 1,
      remainingOffered: '10',
      remainingRequested: '20'
    });
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag OFF → getPswapLineage returns null when the client is not tracking the order', async () => {
    const { midenClientProxy } = await loadProxy(false);
    G.__px.inlineLineage = jest.fn(async () => null);
    expect(await midenClientProxy.getPswapLineage('99')).toBeNull();
  });

  it('flag ON → getPswapLineage dispatches with the order id as a string and parses the DTO back', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const dto = {
      orderId: '77',
      currentTipNoteId: '0xtip',
      currentDepth: 2,
      state: 1,
      remainingOffered: '10',
      remainingRequested: '20'
    };
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify(dto))).toString('base64'),
      durationMs: 3
    }));

    // A BigInt order id must cross as a string (JSON can't encode BigInt).
    const p = midenClientProxy.getPswapLineage(77n);
    await flush();
    fireReady();
    const result = await p;

    expect(G.__px.inlineLineage).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('getPswapLineage');
    expect(env.deadline_ms).toBe(15_000);
    expect(env.argsB64).toEqual(['s:"77"']);
    expect(result).toEqual(dto);
  });

  it('flag ON → a null getPswapLineage result yields null (order not tracked offscreen)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const p = midenClientProxy.getPswapLineage('77');
    await flush();
    fireReady();
    expect(await p).toBeNull();
  });

  it('reads all inline lineages once without IPC and preserves decimal amounts', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const result = await midenClientProxy.getPswapLineages(() => {});

    expect(G.__px.inlineLineages).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineLineage).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        orderId: '77',
        currentTipNoteId: '0xtip',
        currentDepth: 2,
        state: 1,
        remainingOffered: '9007199254740993',
        remainingRequested: '20'
      },
      {
        orderId: '88',
        currentTipNoteId: '0xtip88',
        currentDepth: 0,
        state: 0,
        remainingOffered: '30',
        remainingRequested: '40'
      }
    ]);
  });

  it('does not start a bulk SDK read after the client acquisition loses its hold', async () => {
    const { midenClientProxy } = await loadProxy(false);
    let live = true;
    const acquire = G.__px.getMidenClient;
    G.__px.getMidenClient = jest.fn(async () => {
      const client = await acquire();
      live = false;
      return client;
    });
    await expect(
      midenClientProxy.getPswapLineages(() => {
        if (!live) throw new Error('abandoned hold');
      })
    ).rejects.toThrow('abandoned hold');
    expect(G.__px.inlineLineages).not.toHaveBeenCalled();
  });

  it('does not reduce bulk live records after the SDK read loses its hold', async () => {
    const { midenClientProxy } = await loadProxy(false);
    let live = true;
    const readRecord = jest.fn(() => '77');
    G.__px.inlineLineages = jest.fn(async () => {
      live = false;
      return [{ orderId: readRecord }];
    });
    await expect(
      midenClientProxy.getPswapLineages(() => {
        if (!live) throw new Error('abandoned hold');
      })
    ).rejects.toThrow('abandoned hold');
    expect(readRecord).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [
      {
        orderId: '77',
        currentTipNoteId: '0xtip',
        currentDepth: 2,
        state: 1,
        remainingOffered: '9007199254740993',
        remainingRequested: '20'
      }
    ]
  ])('routes a bulk lineage snapshot through offscreen with no arguments', async (...rows) => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(JSON.stringify(rows)).toString('base64'),
      durationMs: 1
    }));
    const pending = midenClientProxy.getPswapLineages(() => {});
    await flush();
    fireReady();
    expect(await pending).toEqual(rows);
    expect(fakeChrome.runtime.sendMessage.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        method: 'getPswapLineages',
        argsB64: [],
        deadline_ms: 15_000
      })
    );
    expect(G.__px.inlineLineages).not.toHaveBeenCalled();
  });

  it('rejects an absent offscreen bulk snapshot instead of reporting no tracked orders', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const pending = midenClientProxy.getPswapLineages(() => {}).catch((error: Error) => error);
    await flush();
    fireReady();
    expect(await pending).toEqual(new Error('getPswapLineages: offscreen document returned no snapshot'));
  });

  // ── getInputNoteSummary ───────────────────────────────────────────────────
  it('inline summary carries fee assets under its current hold', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const nativeId = 'native-faucet';
    const tokenId = 'token-faucet';
    const record = {
      metadata: jest.fn(() => ({ noteType: () => 1 })),
      details: jest.fn(() => ({
        assets: () => ({
          fungibleAssets: () => [
            { faucetId: () => ({ canonical: nativeId }), amount: () => 10000n },
            { faucetId: () => ({ canonical: tokenId }), amount: () => 7n }
          ]
        })
      }))
    };
    G.__px.inlineGetInputNote.mockResolvedValue(record);
    const summary = await midenClientProxy.getInputNoteSummary('0xn');

    expect(G.__px.inlineGetInputNote).toHaveBeenCalledWith('0xn');
    expect(G.__px.inlineGetInputNote).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({
      noteType: 1,
      assets: [
        { faucetId: nativeId, amount: '10000' },
        { faucetId: tokenId, amount: '7' }
      ]
    });
    expect(record.details).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();

    const client = await G.__px.getMidenClient();
    G.__px.inlineGetInputNote.mockClear();
    G.__px.getMidenClient = jest.fn(async () => {
      G.__px.inlineHold = { mock: 'replacement-during-build' };
      return client;
    });
    await expect(midenClientProxy.getInputNoteSummary('stale-build')).rejects.toThrow('hold replaced');
    expect(G.__px.inlineGetInputNote).not.toHaveBeenCalled();

    const staleRecord = { metadata: record.metadata, details: record.details };
    staleRecord.metadata.mockClear();
    staleRecord.details.mockClear();
    G.__px.getMidenClient = jest.fn(async () => client);
    G.__px.inlineGetInputNote.mockImplementation(async () => {
      G.__px.inlineHold = { mock: 'replacement-during-read' };
      return staleRecord;
    });
    await expect(midenClientProxy.getInputNoteSummary('stale-record')).rejects.toThrow('hold replaced');
    expect(staleRecord.metadata).not.toHaveBeenCalled();
    expect(staleRecord.details).not.toHaveBeenCalled();
  });

  it('flag OFF → getInputNoteSummary returns null for a not-found note (preserves the caller throw)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    G.__px.inlineGetInputNote = jest.fn(async () => null);
    expect(await midenClientProxy.getInputNoteSummary('missing')).toBeNull();
  });

  it('flag ON → getInputNoteSummary dispatches by note id and parses the DTO back', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const nativeId = 'native-faucet';
    const tokenId = 'token-faucet';
    const dto = {
      noteType: 1,
      assets: [
        { faucetId: nativeId, amount: '10000' },
        { faucetId: tokenId, amount: '7' }
      ]
    };
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify(dto))).toString('base64'),
      durationMs: 2
    }));

    const p = midenClientProxy.getInputNoteSummary('0xn');
    await flush();
    fireReady();
    const summary = await p;

    expect(G.__px.inlineGetInputNote).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('getInputNoteSummary');
    expect(env.deadline_ms).toBe(15_000);
    expect(env.argsB64).toEqual(['s:"0xn"']);
    expect(summary).toEqual(dto);
  });

  it('flag ON → a null getInputNoteSummary result is a not-found note (null)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const p = midenClientProxy.getInputNoteSummary('missing');
    await flush();
    fireReady();
    expect(await p).toBeNull();
  });

  // ── importNoteBytes (store WRITE) ─────────────────────────────────────────
  const callerHold = { mock: 'caller-hold' } as unknown as WasmLockHold;

  it('flag OFF → importNoteBytes imports into the inline client store and returns the id', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const bytes = new Uint8Array([1, 2, 3]);
    const id = await midenClientProxy.importNoteBytes(bytes, callerHold);

    expect(G.__px.inlineImportNoteBytes).toHaveBeenCalledWith(bytes, callerHold);
    expect(G.__px.withWasmClientLock).not.toHaveBeenCalled();
    expect(id).toBe('0ximportedid');
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → importNoteBytes ships raw bytes to the offscreen store and returns the imported id', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode('0xoffscreenid')).toString('base64'),
      durationMs: 3
    }));

    const p = midenClientProxy.importNoteBytes(new Uint8Array([0xab, 0xcd]), callerHold);
    await flush();
    fireReady();
    const id = await p;

    // Imported into the OFFSCREEN store, never the dormant SW client.
    expect(G.__px.inlineImportNoteBytes).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('importNoteBytes');
    expect(env.deadline_ms).toBe(15_000);
    // Note bytes cross as RAW base64 (the 'b:' tag), never JSON, and the hold stays in this realm.
    expect(env.argsB64).toHaveLength(1);
    expect(env.argsB64[0].startsWith('b:')).toBe(true);
    expect(Array.from(Buffer.from(env.argsB64[0].slice(2), 'base64'))).toEqual([0xab, 0xcd]);
    expect(id).toBe('0xoffscreenid');
  });

  it('flag ON → a null importNoteBytes result throws (an import must yield an id)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const p = midenClientProxy.importNoteBytes(new Uint8Array([1]), callerHold).catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('no note id');
  });
});

describe('MidenClientProxy - Guardian history ops', () => {
  it.each([
    {
      name: 'importGuardianHistoryP2ideNotes',
      invoke: (proxy: typeof import('./miden-client-proxy').midenClientProxy) =>
        proxy.importGuardianHistoryP2ideNotes('summary', 'account', 'note'),
      inline: () => G.__px.inlineImportGuardianHistoryP2ideNotes,
      args: () => ['summary', 'account', 'note', G.__px.inlineHold],
      expected: undefined
    },
    {
      name: 'decodeGuardianHistory',
      invoke: (proxy: any) => proxy.decodeGuardianHistory('summary'),
      inline: () => G.__px.inlineDecodeGuardianHistory,
      args: () => ['summary', G.__px.inlineHold],
      expected: { __inlineSummary: true }
    },
    {
      name: 'getGuardianResultCommitment',
      invoke: (proxy: any) => proxy.getGuardianResultCommitment(new Uint8Array([4, 2])),
      inline: () => G.__px.inlineGetGuardianResultCommitment,
      args: () => [new Uint8Array([4, 2]), G.__px.inlineHold],
      expected: '0xinlinecommitment'
    }
  ])(
    'flag ON but no chrome.offscreen API → $name runs inline under withWasmClientLock, with the hold it took',
    async ({ invoke, inline, args, expected }) => {
      installChromeMock({ withOffscreen: false });
      const { midenClientProxy } = await loadProxy(true);
      await expect(invoke(midenClientProxy)).resolves.toEqual(expected);
      expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
      expect(inline()).toHaveBeenCalledWith(...args());
      expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    }
  );
});

describe('MidenClientProxy — slice-7-reads getSerializedInputNoteDetails (invalid-note detail batch)', () => {
  // A live-record mock carrying exactly what the detail reducer reaches through.
  // `fungibleAssets: []` keeps the reducer off the SDK bech32 helper (unmocked here)
  // while still proving state/nullifier/noteId reduction and per-id iteration.
  const record = (state: string, nullifier: string) => ({
    details: () => ({ assets: () => ({ fungibleAssets: () => [] }) }),
    state: () => ({ toString: () => state }),
    nullifier: () => ({ toString: () => nullifier })
  });

  it('flag OFF → reduces inline records per id, skips a not-found (null) note, never touches offscreen', async () => {
    const { midenClientProxy } = await loadProxy(false);
    G.__px.inlineGetInputNote = jest.fn(async (id: string) =>
      id === 'missing' ? null : record('Invalid', `null-${id}`)
    );

    const notes = await midenClientProxy.getSerializedInputNoteDetails(['n1', 'missing', 'n2']);

    // One inline getInputNote per requested id (byte-identical to the old handler loop).
    expect(G.__px.inlineGetInputNote).toHaveBeenCalledTimes(3);
    expect(notes).toEqual([
      { noteId: 'n1', state: 'Invalid', assets: [], nullifier: 'null-n1' },
      { noteId: 'n2', state: 'Invalid', assets: [], nullifier: 'null-n2' }
    ]);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag OFF → skips a note whose lookup throws (the inline per-note try/catch)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    G.__px.inlineGetInputNote = jest.fn(async (id: string) => {
      if (id === 'boom') throw new Error('not found');
      return record('Committed', '0xok');
    });

    const notes = await midenClientProxy.getSerializedInputNoteDetails(['boom', 'ok']);
    expect(notes).toEqual([{ noteId: 'ok', state: 'Committed', assets: [], nullifier: '0xok' }]);
  });

  it('flag ON → dispatches the id batch in ONE op (read deadline) and parses the DTO array back', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const dtos = [
      { noteId: 'n1', state: 'Invalid', assets: [{ amount: '5', faucetId: 'mtst1qfaucet' }], nullifier: '0xn1' }
    ];
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify(dtos))).toString('base64'),
      durationMs: 3
    }));

    const p = midenClientProxy.getSerializedInputNoteDetails(['n1', 'n2']);
    await flush();
    fireReady();
    const notes = await p;

    // Never used the dormant SW client.
    expect(G.__px.inlineGetInputNote).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('getSerializedInputNoteDetails');
    expect(env.deadline_ms).toBe(15_000);
    // The whole id array crosses as ONE JSON arg — one offscreen op, not one-per-note.
    expect(env.argsB64).toEqual(['s:["n1","n2"]']);
    expect(notes).toEqual(dtos);
  });

  it('flag ON → a null result yields [] (no matching notes in the offscreen store)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const p = midenClientProxy.getSerializedInputNoteDetails(['n1']);
    await flush();
    fireReady();
    expect(await p).toEqual([]);
  });
});

describe('MidenClientProxy - dryRunTransaction (the USDCx burn fee probe)', () => {
  const REQUEST = new Uint8Array([1, 2, 3]);

  it('flag OFF → dry-runs on the inline client under the caller hold, with no sync and no note import', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const { executeForSummaryAtTip } = await import('@openzeppelin/miden-multisig-client');

    const result = await midenClientProxy.dryRunTransaction('0xaccount', REQUEST, G.__px.inlineHold);

    // The multisig mock's summary serializes to [0xab].
    expect(result).toEqual({ summaryBytes: Buffer.from([0xab]).toString('base64') });
    const inline = await G.__px.getMidenClient.mock.results[0].value;
    expect(G.__px.prepareCustomRequestBytes).toHaveBeenCalledWith(
      inline.client,
      '0xaccount',
      REQUEST,
      G.__px.inlineHold
    );
    expect(executeForSummaryAtTip).toHaveBeenCalledWith(inline.client, '0xaccount', { __request: [1, 2, 3] });
    expect(G.__px.inlineSyncState).not.toHaveBeenCalled();
    expect(G.__px.inlineSync).not.toHaveBeenCalled();
    expect(G.__px.inlineImportNoteBytes).not.toHaveBeenCalled();
    // The caller holds the lock; the proxy takes none of its own.
    expect(G.__px.withWasmClientLock).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → forwards ONE dryRunTransaction op with a deadline and parses its result', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const answer = { executedBytes: 'ZXhlY3V0ZWQ=' };
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify(answer))).toString('base64'),
      durationMs: 2
    }));

    const p = midenClientProxy.dryRunTransaction('0xaccount', REQUEST, G.__px.inlineHold);
    await flush();
    fireReady();

    await expect(p).resolves.toEqual(answer);
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('dryRunTransaction');
    expect(env.deadline_ms).toEqual(expect.any(Number));
    expect(env.deadline_ms).toBeGreaterThan(0);
    expect(env.argsB64).toEqual(['s:"0xaccount"', `b:${Buffer.from(REQUEST).toString('base64')}`]);
    // The service worker's own client is never built for the probe.
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
  });

  it('flag ON → a dry run that answers nothing rejects', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.dryRunTransaction('0xaccount', REQUEST, G.__px.inlineHold).catch((e: Error) => e);
    await flush();
    fireReady();

    expect(await p).toBeInstanceOf(Error);
  });
});

describe('MidenClientProxy — deadline kill', () => {
  it('deadline → closeDocument + reopen + rejects the op with OperationAbortedError', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    // Never resolves → the only way out is the deadline.
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const p = midenClientProxy.call('getAccount', ['acc'], { deadlineMs: 20 }).catch((e: Error) => e);
    await flush();
    fireReady(); // open resolves → message sent → deadline armed
    await flush();
    expect(__test.inFlightSize()).toBe(1);

    await wait(40); // trip the deadline
    fireReady(); // let the reopen's ready gate resolve
    await flush();

    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('deadline');
    expect((err as any).facts).toEqual({
      started: false,
      deadline: { owner: 'own', timer: 'dispatch', killer: 'read' }
    });
    expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    // Reopened a fresh doc (initial create + reopen create).
    expect(fakeChrome.offscreen.createDocument.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(__test.inFlightSize()).toBe(0);
  });

  it('a single kill rejects EVERY in-flight op (closing the doc kills all realms)', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    // Op A trips soon; op B has a far deadline but shares the doc.
    const pA = midenClientProxy.call('getAccount', ['a'], { deadlineMs: 20 }).catch((e: Error) => e);
    const pB = midenClientProxy.call('getAccount', ['b'], { deadlineMs: 100_000 }).catch((e: Error) => e);
    await flush();
    fireReady(); // one ready gate serves both (doc created once)
    await flush();
    expect(__test.inFlightSize()).toBe(2);

    await wait(40); // A's deadline fires → kill → reject A AND B
    fireReady();
    await flush();

    const [errA, errB] = await Promise.all([pA, pB]);
    expect(errA).toBeInstanceOf(OperationAbortedError);
    expect(errB).toBeInstanceOf(OperationAbortedError);
    // B never owned the deadline that closed the document: its report must say so.
    expect((errA as any).facts.deadline.owner).toBe('own');
    expect((errB as any).facts).toEqual({
      started: false,
      deadline: { owner: 'collateral', timer: 'dispatch', killer: 'read' }
    });
    expect(__test.inFlightSize()).toBe(0);
  });

  it('reports the timer that fired even when a start signal lands while the document closes', async () => {
    const { midenClientProxy, __test, markOpStarted } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));
    let finishClose!: () => void;
    fakeChrome.offscreen.closeDocument.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishClose = resolve;
        })
    );

    const p = midenClientProxy.call('getAccount', ['acc'], { deadlineMs: 20 }).catch((e: Error) => e);
    await flush();
    fireReady();
    await flush();
    const [op_id] = __test.inFlightOpIds();
    await wait(40); // the dispatch deadline fires and the close is now pending
    markOpStarted(op_id!);
    finishClose();
    await flush();
    fireReady();
    await flush();

    const err = await p;
    expect((err as any).reason).toBe('deadline');
    // The start signal did arrive before the rejection; the deadline that fired was still the dispatch one.
    expect((err as any).facts).toEqual({
      started: true,
      deadline: { owner: 'own', timer: 'dispatch', killer: 'read' }
    });
  });

  it('§3.3 downgrade: a critical op in flight turns a read deadline into reject-without-kill', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    // Simulate a critical op (a whole-op write) owning the doc via the REAL
    // counter the write path uses.
    const prover = await import('./offscreen-prover');
    prover.incrementCriticalOp();
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const p = midenClientProxy.call('getAccount', ['acc'], { deadlineMs: 20 }).catch((e: Error) => e);
    await flush();
    fireReady();
    await flush();

    await wait(40); // read deadline fires but a critical op owns the doc
    await flush();

    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('deadline-no-kill');
    expect((err as any).facts).toEqual({
      started: false,
      deadline: { owner: 'own', timer: 'dispatch', killer: 'read' }
    });
    // The doc (and the write) survived — no teardown.
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(__test.inFlightSize()).toBe(0);
    prover.decrementCriticalOp();
  });

  it('no deadline (null) → no timer, op settles purely on the response', async () => {
    const phase = (name: string) => process.stderr.write(`READY_PHASE ${Date.now()} ${name} listeners=${fakeChrome.runtime.onMessage.listeners.length} created=${docExists}\n`);
    phase('load-start');
    const { midenClientProxy } = await loadProxy(true);
    phase('load-done');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.call('syncState', [], { deadlineMs: null });
    phase('call-started');
    await flush();
    phase('before-ready');
    fireReady();
    phase('after-ready');
    const result = await p;
    phase('response-received');
    expect(result).toBeNull();
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it('demonstrates early ready is lost while document creation is pending', async () => {
    const { midenClientProxy } = await loadProxy(true);
    let releaseCreate!: () => void;
    const creating = new Promise<void>(resolve => { releaseCreate = resolve; });
    fakeChrome.offscreen.createDocument.mockImplementation(async () => { await creating; docExists = true; });
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({ ok: true, op_id: env.op_id, resultB64: null, durationMs: 1 }));
    const p = midenClientProxy.call('syncState', [], { deadlineMs: null });
    for (let i = 0; i < 50 && fakeChrome.offscreen.createDocument.mock.calls.length === 0; i++) await flush();
    expect(fakeChrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(fakeChrome.runtime.onMessage.listeners).toHaveLength(0);
    fireReady();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    releaseCreate();
    for (let i = 0; i < 50 && fakeChrome.runtime.onMessage.listeners.length === 0; i++) await flush();
    expect(fakeChrome.runtime.onMessage.listeners).toHaveLength(1);
    fireReady();
    await expect(p).resolves.toBeNull();
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it('fixture prematurely fires ready before the listener exists', async () => {
    const { midenClientProxy } = await loadProxy(true);
    let releaseCreate!: () => void;
    const creating = new Promise<void>(resolve => { releaseCreate = resolve; });
    fakeChrome.offscreen.createDocument.mockImplementation(async () => { await creating; docExists = true; });
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({ ok: true, op_id: env.op_id, resultB64: null, durationMs: 1 }));
    const p = midenClientProxy.call('syncState', [], { deadlineMs: null });
    try {
      await flush();
      expect(fakeChrome.runtime.onMessage.listeners).toHaveLength(1);
      fireReady();
    } finally {
      releaseCreate();
      for (let i = 0; i < 50 && fakeChrome.runtime.onMessage.listeners.length === 0; i++) await flush();
      fireReady();
      await p;
    }
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it('recovers after a kill: a fresh call succeeds through the reopened doc (same-store recovery)', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');

    // First op hangs (wedge) so its deadline kills the doc; after reopen we flip
    // sendMessage to a healthy response and prove the next call goes through.
    let wedge = true;
    fakeChrome.runtime.sendMessage.mockImplementation((env: any) => {
      if (wedge) return new Promise(() => {});
      return Promise.resolve({
        ok: true,
        op_id: env.op_id,
        resultB64: Buffer.from([5, 5, 5]).toString('base64'),
        durationMs: 2
      });
    });

    const pKilled = midenClientProxy.call('getAccount', ['a'], { deadlineMs: 20 }).catch((e: Error) => e);
    await flush();
    fireReady(); // initial open
    await flush();
    await wait(40); // trip deadline → closeDocument + reopen
    fireReady(); // reopen ready gate
    await flush();
    expect(await pKilled).toBeInstanceOf(OperationAbortedError);
    expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);

    // Doc is back up (docExists true after reopen) → a fresh getAccount resolves.
    wedge = false;
    const account = await midenClientProxy.getAccount('b');
    expect(account).toEqual({ __account: [5, 5, 5] });
    expect(G.__px.accountDeserialize).toHaveBeenCalledTimes(1);
    expect(__test.inFlightSize()).toBe(0);
  });
});

describe('MidenClientProxy — settlement paths', () => {
  it('an undefined response (doc reaped/closed) → OperationAbortedError(doc-closed)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    fakeChrome.runtime.sendMessage.mockResolvedValue(undefined);

    const p = midenClientProxy.call('getAccount', ['a'], { deadlineMs: null }).catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('doc-closed');
    expect((err as any).facts).toEqual({ started: false });
    // No deadline armed → no kill.
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  // FUNDS-1: a transport rejection is the SAME physical event as the `undefined`
  // response above — the offscreen document went away — so it must settle with the
  // same error TYPE. It used to surface as a bare Error, which classified as an
  // ordinary failure everywhere downstream: `tryCompleteKilledConsume` skipped its
  // node check, and the persisted `rawError` carried no recognizable kill reason.
  it('a sendMessage transport rejection settles as OperationAbortedError(transport), keeping the cause', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    const transportError = new Error('message port closed before a response');
    fakeChrome.runtime.sendMessage.mockRejectedValue(transportError);

    const p = midenClientProxy.call('getAccount', ['a'], { deadlineMs: null }).catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as { reason?: string }).reason).toBe('transport');
    expect((err as { facts?: unknown }).facts).toEqual({ started: false });
    // The original transport message is preserved, not swallowed.
    expect((err as Error).cause).toBe(transportError);
  });
});

