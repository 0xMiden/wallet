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
    Account: { deserialize: (...a: any[]) => g.__px.accountDeserialize(...a) },
    // Slice 5: the flag-on offscreen consume re-hydrates the serialized
    // TransactionResult on the SW side.
    TransactionResult: { deserialize: (...a: any[]) => g.__px.txResultDeserialize(...a) }
  };
});

jest.mock('lib/miden/sdk/miden-client', () => {
  const g = globalThis as any;
  return {
    getMidenClient: (...a: any[]) => g.__px.getMidenClient(...a),
    // The flag-off consume takes the CALLER lock itself (byte-identical to the
    // old switch-under-lock); route through the control so tests can assert it.
    withWasmClientLock: (...a: any[]) => g.__px.withWasmClientLock(...a)
  };
});

// Use the REAL offscreen-prover (issue #260, slice 5): ensureOffscreenDocument /
// forceClose drive the chrome mock, and the criticalOp counters are the genuine
// module state the write path increments — so a "read deadline while a write is
// in flight" downgrade is exercised against real bookkeeping, not a stub.

type OnMessageListener = (msg: any, sender: any, sendResponse: (r?: any) => void) => boolean | undefined;

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
    inlineGetAccount: jest.fn(async () => ({ __inlineAccount: true })),
    // The inline (flag-off) client also exposes the slice-3/4/5 methods so the
    // flag-off pass-through of each is assertable against a spy.
    inlineSyncState: jest.fn(async () => ({ __syncSummary: true })),
    // Slice 6b: the flag-off pass-through of the structural commit-wait.
    inlineWaitForTransactionCommit: jest.fn(async () => {}),
    // Slice 7b: the flag-off pass-through of the private-note relay.
    inlineSendPrivateNote: jest.fn(async () => {}),
    inlineRelayPrivateNoteById: jest.fn(async () => {}),
    inlineIsOutputNoteConsumed: jest.fn(async () => false),
    inlineExportNote: jest.fn(async () => new Uint8Array([1, 2, 3])),
    inlineGetInputNoteDetails: jest.fn(async () => [{ __inlineDetail: true }]),
    inlineGetConsumableNoteDtos: jest.fn(async () => [{ __inlineConsumable: true }]),
    inlineConsumeNoteId: jest.fn(async () => ({ __inlineTxResult: true })),
    // Slice 5b: the flag-off passthrough of each remaining non-guardian write.
    inlineSendTransaction: jest.fn(async () => ({ __inlineSendResult: true })),
    inlineSwapTransaction: jest.fn(async () => ({ __inlineSwapResult: true })),
    inlineNewTransaction: jest.fn(async () => ({ __inlineNewResult: true })),
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
    inlineGetInputNote: jest.fn(async () => ({ metadata: () => ({ noteType: () => 1 }) })),
    inlineGetTransactionCommitState: jest.fn(async () => 'committed'),
    inlineImportNoteBytes: jest.fn(async () => '0ximportedid'),
    inlineDrainPrivateNoteTransport: jest.fn(async () => {}),
    inlineImportRecoveryNoteBytes: jest.fn(async () => ({ imported: 2, failures: 0 })),
    inlineRecoverPublicNotesRange: jest.fn(async () => ({ imported: 3, failures: 0 })),
    inlineResolveRecoveryScanRange: jest.fn(async () => ({ startBlock: 7, latestBlock: 99 })),
    // A real pass-through lock so the flag-off "caller lock preserved" assertion
    // is meaningful (spy call count) while still executing the wrapped op.
    withWasmClientLock: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    getMidenClient: jest.fn(async () => ({
      getAccount: (...a: any[]) => G.__px.inlineGetAccount(...a),
      syncState: (...a: any[]) => G.__px.inlineSyncState(...a),
      waitForTransactionCommit: (...a: any[]) => G.__px.inlineWaitForTransactionCommit(...a),
      sendPrivateNote: (...a: any[]) => G.__px.inlineSendPrivateNote(...a),
      relayPrivateNoteById: (...a: any[]) => G.__px.inlineRelayPrivateNoteById(...a),
      isOutputNoteConsumed: (...a: any[]) => G.__px.inlineIsOutputNoteConsumed(...a),
      exportNote: (...a: any[]) => G.__px.inlineExportNote(...a),
      getInputNoteDetails: (...a: any[]) => G.__px.inlineGetInputNoteDetails(...a),
      getTransactionCommitState: (...a: any[]) => G.__px.inlineGetTransactionCommitState(...a),
      getConsumableNoteDtos: (...a: any[]) => G.__px.inlineGetConsumableNoteDtos(...a),
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
      client: {
        getSyncHeight: (...a: any[]) => G.__px.inlineGetSyncHeight(...a),
        sync: (...a: any[]) => G.__px.inlineSync(...a),
        pswap: { lineage: (...a: any[]) => G.__px.inlineLineage(...a) }
      }
    }))
  };
}

/** Set the flag, reset module registry, and import a fresh proxy. */
async function loadProxy(flagOn: boolean) {
  if (flagOn) process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
  else delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  jest.resetModules();
  return import('./miden-client-proxy');
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
    expect(G.__px.inlineImportRecoveryNoteBytes).toHaveBeenCalledWith(noteBytes);
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

  it('flag ON → dispatches OFFSCREEN_CALL to the realm that created the note, crossing the note as SERIALIZED bytes; the SW client is NEVER used', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { isCriticalOpInFlight } = await import('./offscreen-prover');
    // Sampled from inside the dispatch, the only point the in-flight bracket is
    // observable — the counter is back to zero by the time the call resolves.
    let criticalDuringRelay: boolean | undefined;
    // The offscreen side relays and returns null (void discarded).
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      criticalDuringRelay = isCriticalOpInFlight();
      return { ok: true, op_id: env.op_id, resultB64: null, durationMs: 4 };
    });

    const note = makeNote([0xde, 0xad, 0xbe, 0xef]);
    const p = midenClientProxy.sendPrivateNote(note as any, 'mtst1qrecipient');
    await flush();
    fireReady();
    const result = await p;

    expect(result).toBeUndefined();
    // THE FIX: the relay crossed to the offscreen realm (which owns the note + the
    // fresh sync height); the dormant SW client — whose stale height would overshoot
    // the note's commitment — was NEVER used.
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.inlineSendPrivateNote).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.type).toBe('OFFSCREEN_CALL');
    expect(env.method).toBe('sendPrivateNote');
    // A write-class deadline (45s), NOT a read's 15s, and dispatched as CRITICAL.
    //
    // This asserted 15s on the reasoning that a transport relay does no prove or
    // sign — true of the work, but the stakes are a write's: the transaction has
    // already landed, so an abort here does not undo a spend, it strands one. Two
    // things follow from `critical`, and both are the point:
    //   - `deadline_ms` is not armed at dispatch but at EXECUTION START, when the op
    //     wins the offscreen WASM mutex, so queue-wait behind other ops is
    //     off-budget. Burning a 15s budget in that queue and aborting before the
    //     first request is the reported OperationAbortedError.
    //   - a coincident cheap read's deadline downgrades to a reject-without-kill
    //     instead of tearing down the realm mid-relay.
    expect(env.deadline_ms).toBe(45_000);
    expect(criticalDuringRelay).toBe(true);
    // ...and the bracket is released once the relay resolves.
    expect(isCriticalOpInFlight()).toBe(false);
    // The Note crossed as RAW serialized bytes (the 'b:' tag), never JSON/handle...
    expect(env.argsB64[0].startsWith('b:')).toBe(true);
    expect(Array.from(Buffer.from(env.argsB64[0].slice(2), 'base64'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    // ...and the recipient id crossed as a JSON string.
    expect(env.argsB64[1]).toBe('s:"mtst1qrecipient"');
  });

  it('flag ON → relayPrivateNoteById is dispatched as CRITICAL on the relay deadline, carrying only ids', async () => {
    // The sweep's re-push. Same realm requirement and same stakes as the original
    // relay — the note lives in the offscreen store and the transaction has already
    // landed — so it must not be a cheap read that a coincident deadline can tear
    // down. It differs only in having no live Note: the row is all the sweep has.
    const { midenClientProxy } = await loadProxy(true);
    const { isCriticalOpInFlight } = await import('./offscreen-prover');
    let criticalDuringRelay: boolean | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      criticalDuringRelay = isCriticalOpInFlight();
      return { ok: true, op_id: env.op_id, resultB64: null, durationMs: 3 };
    });

    const p = midenClientProxy.relayPrivateNoteById('0xnote', 'mtst1qrecipient');
    await flush();
    fireReady();
    await p;

    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('relayPrivateNoteById');
    expect(env.deadline_ms).toBe(45_000);
    expect(criticalDuringRelay).toBe(true);
    expect(env.argsB64[0]).toBe('s:"0xnote"');
    expect(env.argsB64[1]).toBe('s:"mtst1qrecipient"');
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

    // Verbatim `(await getMidenClient()).client.sync().blockNum()` — NOT getSyncHeight.
    expect(G.__px.inlineSync).toHaveBeenCalledTimes(1);
    expect(G.__px.inlineGetSyncHeight).not.toHaveBeenCalled();
    expect(height).toBe(5000);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
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

  // ── getInputNoteSummary ───────────────────────────────────────────────────
  it('flag OFF → getInputNoteSummary reduces the inline live InputNoteRecord to its noteType', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const summary = await midenClientProxy.getInputNoteSummary('0xn');

    expect(G.__px.inlineGetInputNote).toHaveBeenCalledWith('0xn');
    expect(summary).toEqual({ noteType: 1 });
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag OFF → getInputNoteSummary returns null for a not-found note (preserves the caller throw)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    G.__px.inlineGetInputNote = jest.fn(async () => null);
    expect(await midenClientProxy.getInputNoteSummary('missing')).toBeNull();
  });

  it('flag ON → getInputNoteSummary dispatches by note id and parses the DTO back', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from(new TextEncoder().encode(JSON.stringify({ noteType: 1 }))).toString('base64'),
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
    expect(summary).toEqual({ noteType: 1 });
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
  it('flag OFF → importNoteBytes imports into the inline client store and returns the id', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const bytes = new Uint8Array([1, 2, 3]);
    const id = await midenClientProxy.importNoteBytes(bytes);

    expect(G.__px.inlineImportNoteBytes).toHaveBeenCalledWith(bytes);
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

    const p = midenClientProxy.importNoteBytes(new Uint8Array([0xab, 0xcd]));
    await flush();
    fireReady();
    const id = await p;

    // Imported into the OFFSCREEN store, never the dormant SW client.
    expect(G.__px.inlineImportNoteBytes).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('importNoteBytes');
    expect(env.deadline_ms).toBe(15_000);
    // Note bytes cross as RAW base64 (the 'b:' tag), never JSON.
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
    const p = midenClientProxy.importNoteBytes(new Uint8Array([1])).catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('no note id');
  });
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
    expect(__test.inFlightSize()).toBe(0);
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
    // The doc (and the write) survived — no teardown.
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(__test.inFlightSize()).toBe(0);
    prover.decrementCriticalOp();
  });

  it('no deadline (null) → no timer, op settles purely on the response', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const p = midenClientProxy.call('syncState', [], { deadlineMs: null });
    await flush();
    fireReady();
    const result = await p;
    expect(result).toBeNull();
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
    // The original transport message is preserved, not swallowed.
    expect((err as Error).cause).toBe(transportError);
  });
});

// ─── Slice 5a: consumeNoteId (the WRITE pipeline) ───────────────────────────

const consumeTx = () => ({
  id: 'tx-1',
  type: 'consume' as const,
  accountId: 'mtst1qacc',
  noteId: '0xn1',
  noteIds: ['0xn1', '0xn2'],
  amount: 5n, // a BigInt — proves the minimal DTO (never JSON.stringify(tx)) is shipped
  delegateTransaction: false,
  status: 0,
  initiatedAt: 0,
  displayIcon: 'RECEIVE'
});

describe('MidenClientProxy — slice-5a consumeNoteId flag routing + byte-identity', () => {
  it('flag OFF → consumeNoteId runs inline under withWasmClientLock with the wrapped sign options (byte-identical)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const tx = consumeTx();
    const result = await midenClientProxy.consumeNoteId(tx as any, signCallback);

    // The caller lock wraps the op (exactly as the old switch-under-lock did).
    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    // getMidenClient was resolved WITH the wrapped sign-callback options.
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    const opts = G.__px.getMidenClient.mock.calls[0][0];
    expect(typeof opts.signCallback).toBe('function');
    // The inline client's consumeNoteId ran on the full tx object.
    expect(G.__px.inlineConsumeNoteId).toHaveBeenCalledWith(tx);
    expect(result).toEqual({ __inlineTxResult: true });
    // Offscreen never touched.
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag OFF → the wrapped sign option hex-converts args and tags a thrown error via buildSignCallbackError', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const rawSign = jest.fn(async () => {
      throw new Error('wallet is locked');
    });
    await midenClientProxy.consumeNoteId(consumeTx() as any, rawSign);
    const opts = G.__px.getMidenClient.mock.calls[0][0];
    // The SDK keystore would call opts.signCallback with BYTES; assert it hex-
    // converts and wraps a throw with a `reason` tag (the #313 classification).
    let thrown: any;
    try {
      await opts.signCallback(new Uint8Array([0xab, 0xcd]), new Uint8Array([0x01]));
    } catch (e) {
      thrown = e;
    }
    expect(rawSign).toHaveBeenCalledWith('abcd', '01');
    expect(thrown.reason).toBe('locked');
  });

  it('flag ON but no chrome.offscreen API → consumeNoteId falls back inline', async () => {
    installChromeMock({ withOffscreen: false });
    const { midenClientProxy } = await loadProxy(true);
    const result = await midenClientProxy.consumeNoteId(
      consumeTx() as any,
      jest.fn(async () => new Uint8Array())
    );
    expect(G.__px.inlineConsumeNoteId).toHaveBeenCalled();
    expect(result).toEqual({ __inlineTxResult: true });
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → dispatches a whole-op OFFSCREEN_CALL (minimal DTO, write deadline, criticalOp bracketed) + rehydrates', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const prover = await import('./offscreen-prover');
    let criticalDuring: boolean | undefined;
    let signCbSizeDuring: number | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      criticalDuring = prover.isCriticalOpInFlight();
      signCbSizeDuring = __test.opSignCallbacksSize();
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1, 2, 3]).toString('base64'), durationMs: 4 };
    });

    const p = midenClientProxy.consumeNoteId(
      consumeTx() as any,
      jest.fn(async () => new Uint8Array())
    );
    await flush();
    fireReady();
    const result = await p;

    // Never used the inline SW client — and NEVER held the SW WASM lock (flag-on
    // serializes in the offscreen doc, keeping the SW free + sign handler unblocked).
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.withWasmClientLock).not.toHaveBeenCalled();
    // Exactly one OFFSCREEN_CALL, method consumeNoteId, write deadline, MINIMAL DTO.
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('consumeNoteId');
    expect(env.deadline_ms).toBe(__test.writeDeadlineMs());
    expect(env.deadline_ms).toBe(90_000);
    // The DTO carries only the 4 fields the op reads — NOT the BigInt-bearing tx.
    const sentDto = JSON.parse(env.argsB64[0].slice(2));
    expect(sentDto).toEqual({
      accountId: 'mtst1qacc',
      noteId: '0xn1',
      noteIds: ['0xn1', '0xn2'],
      delegateTransaction: false
    });
    // criticalOp + sign callback were bracketed AROUND the op, cleaned up after.
    expect(criticalDuring).toBe(true);
    expect(signCbSizeDuring).toBe(1);
    expect(prover.isCriticalOpInFlight()).toBe(false);
    expect(__test.opSignCallbacksSize()).toBe(0);
    // SW re-hydrated the serialized TransactionResult (WASM ensured first).
    expect(G.__px.getWasmOrThrow).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ __txResult: [1, 2, 3] });
    expect(__test.inFlightSize()).toBe(0);
  });

  it('flag ON → a null offscreen result throws (a consume must always yield a TransactionResult)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const p = midenClientProxy
      .consumeNoteId(
        consumeTx() as any,
        jest.fn(async () => new Uint8Array())
      )
      .catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('no TransactionResult bytes');
    // No re-hydrate attempted for a null result.
    expect(G.__px.txResultDeserialize).not.toHaveBeenCalled();
  });
});

describe('MidenClientProxy — slice-5a reverse-IPC sign', () => {
  it('handleOffscreenSignRequest signs via the op-registered callback (not the fallback) and returns bytes', async () => {
    const { midenClientProxy, handleOffscreenSignRequest, __test } = await loadProxy(true);
    const { bytesToB64 } = await import('./offscreen-codec');
    const opSign = jest.fn(async () => new Uint8Array([0xaa, 0xbb]));
    const fallback = jest.fn(async () => new Uint8Array([0xff]));

    // The offscreen op requests a signature mid-execute; capture the op_id and
    // drive the reverse-IPC handler with it.
    let signResult: any;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      signResult = await handleOffscreenSignRequest(
        {
          target: 'sw',
          type: 'OFFSCREEN_SIGN_REQUEST',
          op_id: env.op_id,
          sign_id: 's-1',
          publicKeyB64: bytesToB64(new Uint8Array([0x01, 0x02])),
          signingInputsB64: bytesToB64(new Uint8Array([0x03, 0x04]))
        } as any,
        fallback
      );
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([9]).toString('base64'), durationMs: 1 };
    });

    const p = midenClientProxy.consumeNoteId(consumeTx() as any, opSign);
    await flush();
    fireReady();
    await p;

    // The op's OWN callback signed (with hex-converted args), never the fallback.
    expect(opSign).toHaveBeenCalledWith('0102', '0304');
    expect(fallback).not.toHaveBeenCalled();
    expect(signResult.ok).toBe(true);
    expect(Array.from(Buffer.from(signResult.signatureB64, 'base64'))).toEqual([0xaa, 0xbb]);
    expect(__test.opSignCallbacksSize()).toBe(0); // cleaned up
  });

  it('a sign round-trip on a null-deadline op un-pauses without re-arming a timer', async () => {
    const { handleOffscreenSignRequest, __test } = await loadProxy(true);
    const { bytesToB64 } = await import('./offscreen-codec');
    let settleOp!: (v: any) => void;
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(resolve => (settleOp = resolve)));

    // A critical op with NO deadline (deadlineMs: null).
    const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], null);
    void promise.catch(() => {});
    await flush();
    fireReady();
    await flush();
    expect(__test.hasOpTimer(op_id)).toBe(false); // null deadline → never a timer

    await handleOffscreenSignRequest(
      {
        target: 'sw',
        type: 'OFFSCREEN_SIGN_REQUEST',
        op_id,
        sign_id: 's',
        publicKeyB64: bytesToB64(new Uint8Array([1])),
        signingInputsB64: bytesToB64(new Uint8Array([2]))
      } as any,
      jest.fn(async () => new Uint8Array([9]))
    );
    // Paused then un-paused; still no timer (nothing to re-arm for a null deadline).
    expect(__test.isOpPaused(op_id)).toBe(false);
    expect(__test.hasOpTimer(op_id)).toBe(false);

    settleOp({ ok: true, op_id, resultB64: null, durationMs: 1 });
    await promise;
    expect(__test.inFlightSize()).toBe(0);
  });

  it('handleOffscreenSignRequest falls back to the default callback when no op is registered', async () => {
    const { handleOffscreenSignRequest } = await loadProxy(true);
    const { bytesToB64 } = await import('./offscreen-codec');
    const fallback = jest.fn(async () => new Uint8Array([0x7]));
    const resp = await handleOffscreenSignRequest(
      {
        target: 'sw',
        type: 'OFFSCREEN_SIGN_REQUEST',
        op_id: 'unregistered',
        sign_id: 's',
        publicKeyB64: bytesToB64(new Uint8Array([0xa])),
        signingInputsB64: bytesToB64(new Uint8Array([0xb]))
      } as any,
      fallback
    );
    expect(fallback).toHaveBeenCalledWith('0a', '0b');
    expect((resp as any).ok).toBe(true);
  });

  it('locked vault mid-sign → DEFER: op-keyed error tag (isLockedError) — issue #313', async () => {
    const { midenClientProxy, handleOffscreenSignRequest } = await loadProxy(true);
    const { bytesToB64 } = await import('./offscreen-codec');
    // The op's signer throws a locked error (as the SW vault does when locked).
    const opSign = jest.fn(async () => {
      throw Object.assign(new Error('Wallet is locked: vault unavailable'), { reason: 'locked' });
    });

    let signResp: any;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      signResp = await handleOffscreenSignRequest(
        {
          target: 'sw',
          type: 'OFFSCREEN_SIGN_REQUEST',
          op_id: env.op_id,
          sign_id: 's',
          publicKeyB64: bytesToB64(new Uint8Array([1])),
          signingInputsB64: bytesToB64(new Uint8Array([2]))
        } as any,
        jest.fn()
      );
      // The offscreen execute now FAILS because the sign threw.
      return { ok: false, op_id: env.op_id, error: 'sign failed in offscreen execute' };
    });

    const errP = midenClientProxy.consumeNoteId(consumeTx() as any, opSign).catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await errP;

    // The sign handler classified the vault error as 'locked' and reported it.
    expect(signResp.ok).toBe(false);
    expect(signResp.reason).toBe('locked');
    // The consume error is tagged reason:'locked' (OP-KEYED, no global slot) so
    // isLockedError(err) → defer. This is the SOLE carrier of the locked signal
    // for a flag-on offscreen write (issue #260 flip-prep #1).
    expect((err as any).reason).toBe('locked');
  });
});

// Issue #260 flip-prep #3: the whole-op WRITE's REAL deadline is armed at EXECUTION
// START (when the op wins the offscreen WASM mutex and posts OFFSCREEN_OP_STARTED
// → markOpStarted), NOT at dispatch. So queue-wait behind other ops on the single
// offscreen mutex is off-budget: a write that sits in the queue for longer than
// its WRITE_DEADLINE is NOT falsely killed before it executes. At dispatch a
// GENEROUS `CRITICAL_DISPATCH_BACKSTOP_MS` backstop is armed instead (defense-in-
// depth): if the start signal is dropped, the write is eventually reclaimed rather
// than hanging timer-less until SW eviction. `markOpStarted` REPLACES the backstop
// with the real deadline.
describe('MidenClientProxy — slice-flip-prep #3 arm-on-start write deadline', () => {
  it('a queued critical write (no OFFSCREEN_OP_STARTED yet) is NOT killed while it waits below the backstop', async () => {
    // Case (c): a write legitimately queued behind slow ops for less than the
    // backstop must NOT be false-killed — the exact bug arm-on-start fixed.
    jest.useFakeTimers();
    try {
      const { __test } = await loadProxy(true);
      // The offscreen op never responds — it is stuck behind the head-of-queue op,
      // and never posts OFFSCREEN_OP_STARTED (it has not begun executing).
      fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

      const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], __test.writeDeadlineMs());
      void promise.catch(() => {});
      await jest.advanceTimersByTimeAsync(0);
      fireReady(); // open resolves → OFFSCREEN_CALL sent, but the op has NOT started
      await jest.advanceTimersByTimeAsync(0);
      // A timer IS armed at dispatch — but it is the GENEROUS backstop, not the real
      // WRITE_DEADLINE (which is off-budget until execution start, flip-prep #3).
      expect(__test.hasOpTimer(op_id)).toBe(true);

      // Advance FAR past the real write deadline but still below the backstop —
      // stated against the backstop itself rather than as a fixed offset from the
      // deadline, so raising the deadline can't silently push this onto (or past)
      // the backstop and make the test assert the opposite of its name.
      expect(__test.writeDeadlineMs()).toBeLessThan(__test.criticalDispatchBackstopMs());
      await jest.advanceTimersByTimeAsync(__test.criticalDispatchBackstopMs() - 1_000);
      // It was NOT killed: no closeDocument, still in flight — the backstop cannot
      // false-kill a merely-queued write (no false-kill regression).
      expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
      expect(__test.inFlightSize()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a critical write that NEVER receives OFFSCREEN_OP_STARTED is killed by the dispatch backstop (bounded, not hung forever)', async () => {
    // Case (a): the defense-in-depth guarantee. If the start signal is dropped while
    // the SW stays alive, the backstop reclaims the op instead of letting it hang.
    jest.useFakeTimers();
    try {
      const { __test } = await loadProxy(true);
      const { OperationAbortedError } = await import('./offscreen-codec');
      // The op never responds AND never posts OFFSCREEN_OP_STARTED (dropped signal).
      fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

      const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], __test.writeDeadlineMs());
      const p = promise.catch((e: Error) => e);
      await jest.advanceTimersByTimeAsync(0);
      fireReady();
      await jest.advanceTimersByTimeAsync(0);
      // A backstop timer IS armed at dispatch — pre-fix this armed NOTHING for a
      // critical write, so a dropped start signal hung the op forever.
      expect(__test.hasOpTimer(op_id)).toBe(true);

      // Past the real write deadline but below the backstop, with NO start signal:
      // still alive — the real deadline is never armed without markOpStarted.
      await jest.advanceTimersByTimeAsync(__test.writeDeadlineMs() + 30_000);
      expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
      expect(__test.inFlightSize()).toBe(1);

      // Crossing the backstop reclaims the dropped-start op — a BOUNDED kill.
      await jest.advanceTimersByTimeAsync(__test.criticalDispatchBackstopMs());
      fireReady(); // reopen ready gate after the kill
      await jest.advanceTimersByTimeAsync(0);

      const err = await p;
      expect(err).toBeInstanceOf(OperationAbortedError);
      expect((err as any).reason).toBe('deadline');
      expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
      expect(__test.inFlightSize()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('markOpStarted before the backstop REPLACES it with the real WRITE_DEADLINE (kill a full write deadline from start, not the backstop)', async () => {
    // Case (b): the normal path. The op starts before the backstop fires; the real
    // deadline governs, so the effective kill time is a full write deadline from start — NOT the backstop.
    jest.useFakeTimers();
    try {
      const { __test, markOpStarted } = await loadProxy(true);
      const { OperationAbortedError } = await import('./offscreen-codec');
      fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

      // Dispatch with the REAL WRITE_DEADLINE so the kill time is measured against
      // production values (not a scaled-down stand-in).
      const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], __test.writeDeadlineMs());
      const p = promise.catch((e: Error) => e);
      await jest.advanceTimersByTimeAsync(0);
      fireReady();
      await jest.advanceTimersByTimeAsync(0);
      expect(__test.hasOpTimer(op_id)).toBe(true); // backstop armed at dispatch

      // The op wins the mutex and begins executing BEFORE the backstop would fire →
      // markOpStarted clears the backstop and arms the real deadline afresh.
      markOpStarted(op_id);
      expect(__test.hasOpTimer(op_id)).toBe(true);

      // Just under the real write deadline from start: NOT killed yet ...
      await jest.advanceTimersByTimeAsync(__test.writeDeadlineMs() - 1_000);
      expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
      expect(__test.inFlightSize()).toBe(1);

      // ... crossing the real write deadline kills it — the effective budget is one write deadline
      // from start, NOT the backstop (which markOpStarted replaced).
      await jest.advanceTimersByTimeAsync(2_000);
      fireReady(); // reopen ready gate after the kill
      await jest.advanceTimersByTimeAsync(0);

      const err = await p;
      expect(err).toBeInstanceOf(OperationAbortedError);
      expect((err as any).reason).toBe('deadline');
      expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
      // The kill happened at the real write deadline — WELL below the backstop.
      expect(__test.writeDeadlineMs()).toBeLessThan(__test.criticalDispatchBackstopMs());
      expect(__test.inFlightSize()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('markOpStarted arms the (short) deadline at execution start → a subsequent wedge IS killed', async () => {
    const { __test, markOpStarted } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], 20);
    const p = promise.catch((e: Error) => e);
    await flush();
    fireReady();
    await flush();
    // The generous backstop is armed at dispatch (defense-in-depth vs a dropped start
    // signal); the SHORT real deadline is NOT — it is off-budget until execution start.
    expect(__test.hasOpTimer(op_id)).toBe(true);

    // The op wins the WASM mutex and begins executing → OFFSCREEN_OP_STARTED. This
    // REPLACES the backstop with the op's real (here short 20ms) deadline.
    markOpStarted(op_id);
    expect(__test.hasOpTimer(op_id)).toBe(true); // now the real deadline

    await wait(40); // it then wedges in-realm → its own deadline fires
    fireReady(); // reopen ready gate
    await flush();

    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('deadline');
    expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(__test.inFlightSize()).toBe(0);
  });

  it('markOpStarted on an already-settled/unknown op is a no-op', async () => {
    const { markOpStarted } = await loadProxy(true);
    // Must not throw for an op id that is not in flight.
    expect(() => markOpStarted('never-dispatched')).not.toThrow();
  });
});

describe('MidenClientProxy — slice-5a §5 write kill window', () => {
  it("the write's OWN deadline fires (unresolved op = wedged execute/prove/submit/apply) → closeDocument + reject + reopen", async () => {
    const { __test, markOpStarted } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    // The offscreen op never responds → only the write's own deadline can end it.
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], 20);
    const p = promise.catch((e: Error) => e);
    await flush();
    fireReady(); // open resolves → message sent
    await flush();
    expect(__test.inFlightSize()).toBe(1);
    expect(op_id).toBeTruthy();
    markOpStarted(op_id); // op wins the mutex + begins executing → deadline armed

    await wait(40); // trip the write's own deadline
    fireReady(); // reopen ready gate
    await flush();

    const err = await p;
    // A CRITICAL op's own deadline KILLS (the wedge case), unlike a coincident read.
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('deadline');
    expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(fakeChrome.offscreen.createDocument.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(__test.inFlightSize()).toBe(0);
  });

  it('deadline PAUSED during a sign round-trip: a slow sign never triggers a kill; re-armed on the response', async () => {
    const { handleOffscreenSignRequest, __test, markOpStarted } = await loadProxy(true);
    const { bytesToB64 } = await import('./offscreen-codec');
    // The op stays open until we settle it (so the test controls its lifetime and
    // leaves no dangling re-armed timer for a later test).
    let settleOp!: (v: any) => void;
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(resolve => (settleOp = resolve)));

    // Dispatch a critical op with a SHORT deadline.
    const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], 30);
    void promise.catch(() => {});
    await flush();
    fireReady();
    await flush();
    markOpStarted(op_id); // op wins the mutex + begins executing → deadline armed
    expect(__test.inFlightSize()).toBe(1);
    expect(__test.hasOpTimer(op_id)).toBe(true);
    expect(__test.isOpPaused(op_id)).toBe(false);

    // Start a sign round-trip whose signer NEVER resolves (a hung Face-ID / unlock).
    let releaseSign!: (v: Uint8Array) => void;
    const slowSigner = jest.fn(() => new Promise<Uint8Array>(resolve => (releaseSign = resolve)));
    const signPromise = handleOffscreenSignRequest(
      {
        target: 'sw',
        type: 'OFFSCREEN_SIGN_REQUEST',
        op_id,
        sign_id: 's',
        publicKeyB64: bytesToB64(new Uint8Array([1])),
        signingInputsB64: bytesToB64(new Uint8Array([2]))
      } as any,
      slowSigner as any
    );
    await flush();
    // The deadline is PAUSED: its timer was cleared for the round-trip.
    expect(__test.isOpPaused(op_id)).toBe(true);
    expect(__test.hasOpTimer(op_id)).toBe(false);

    // Wait far PAST the 30ms deadline while the sign is outstanding — NO kill.
    await wait(80);
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(__test.inFlightSize()).toBe(1);
    expect(__test.isOpPaused(op_id)).toBe(true);

    // Release the sign → deadline re-armed (fresh), op still alive.
    releaseSign(new Uint8Array([0x1]));
    await signPromise;
    await flush();
    expect(__test.isOpPaused(op_id)).toBe(false);
    expect(__test.hasOpTimer(op_id)).toBe(true);
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();

    // Settle the op cleanly so its re-armed deadline timer is cleared and doesn't
    // leak into a later test (which would fire onDeadline against this module).
    settleOp({ ok: true, op_id, resultB64: null, durationMs: 1 });
    await promise;
    expect(__test.inFlightSize()).toBe(0);
  });

  it('a coincident READ deadline does NOT kill a live write (downgrade), then the write completes', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');

    // A critical write op is in flight (never responds until we let it).
    let resolveWrite!: (v: any) => void;
    let writeEnvOpId = '';
    fakeChrome.runtime.sendMessage.mockImplementation((env: any) => {
      if (env.method === 'consumeNoteId') {
        writeEnvOpId = env.op_id;
        return new Promise(resolve => (resolveWrite = resolve));
      }
      // The read hangs so its own (short) deadline fires.
      return new Promise(() => {});
    });

    const writeP = midenClientProxy.consumeNoteId(
      consumeTx() as any,
      jest.fn(async () => new Uint8Array())
    );
    void writeP.catch(() => {}); // avoid an unhandled-rejection race if it ever rejects
    await flush();
    fireReady();
    await flush();
    expect(__test.inFlightSize()).toBe(1); // the write
    const prover = await import('./offscreen-prover');
    expect(prover.isCriticalOpInFlight()).toBe(true); // the write bumped criticalOp

    // Fire a cheap READ with a short deadline WHILE the write is in flight.
    const readP = midenClientProxy.call('getAccount', ['acc'], { deadlineMs: 20 }).catch((e: Error) => e);
    await flush();
    await wait(40); // read deadline fires — but a critical write owns the doc
    await flush();

    const readErr = await readP;
    expect(readErr).toBeInstanceOf(OperationAbortedError);
    expect((readErr as any).reason).toBe('deadline-no-kill');
    // The realm (and the write) SURVIVED — no teardown.
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();

    // The write then completes normally.
    resolveWrite({ ok: true, op_id: writeEnvOpId, resultB64: Buffer.from([7]).toString('base64'), durationMs: 1 });
    const result = await writeP;
    expect(result).toEqual({ __txResult: [7] });
    expect(__test.inFlightSize()).toBe(0);
  });
});

// ─── Slice 5b: send / swap / newTransaction (the remaining WRITE pipeline) ────
//
// Each mirrors the slice-5a consumeNoteId contract exactly: flag-OFF is
// BYTE-IDENTICAL to production (inline under withWasmClientLock with the wrapped
// sign options); flag-ON is a whole-op OFFSCREEN_CALL (minimal DTO / raw bytes in,
// serialized TransactionResult out) run on the SHARED critical machinery (write-deadline
// deadline, criticalOp bracketing, op-scoped sign callback). The kill-window /
// sign-pause / read-downgrade matrix is the SAME shared `dispatchOp` path the
// slice-5a tests exercise via `__test.dispatchCritical` (method-agnostic); the
// per-method tests below prove the ROUTING, DTO field-set, byte-identity, and that
// a killed write rejects with OperationAbortedError (→ the loop marks it Failed).

const sendTx = () => ({
  id: 'tx-send',
  type: 'send' as const,
  accountId: 'mtst1qacc',
  secondaryAccountId: 'mtst1qrecipient',
  faucetId: 'mtst1qfaucet',
  noteType: 'public',
  amount: 1000n, // a BigInt — proves the DTO ships amount as a string, never JSON.stringify(tx)
  delegateTransaction: false,
  extraInputs: { recallBlocks: 100 },
  status: 0,
  initiatedAt: 0,
  displayIcon: 'SEND'
});

const swapTx = () => ({
  id: 'tx-swap',
  type: 'swap' as const,
  accountId: 'mtst1qacc',
  faucetId: 'mtst1qoffered',
  amount: 500n, // BigInt offered amount → decimal string in the DTO
  delegateTransaction: false,
  extraInputs: { requestedFaucetId: 'mtst1qrequested', requestedAmount: 250n, expirySeconds: 120, autoConsume: true },
  status: 0,
  initiatedAt: 0,
  displayIcon: 'SWAP'
});

describe('MidenClientProxy — slice-5b sendTransaction flag routing + byte-identity', () => {
  it('flag OFF → sendTransaction runs inline under withWasmClientLock with wrapped sign options (byte-identical)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const tx = sendTx();
    const result = await midenClientProxy.sendTransaction(tx as any, signCallback);

    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    const opts = G.__px.getMidenClient.mock.calls[0][0];
    expect(typeof opts.signCallback).toBe('function');
    // The inline client's sendTransaction ran on the full tx object. The trailing
    // `onStage` is the PR #524 stage stamp, passed straight through (undefined here
    // — this caller supplied none).
    expect(G.__px.inlineSendTransaction).toHaveBeenCalledWith(tx, undefined);
    expect(result).toEqual({ __inlineSendResult: true });
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON but no chrome.offscreen API → sendTransaction falls back inline', async () => {
    installChromeMock({ withOffscreen: false });
    const { midenClientProxy } = await loadProxy(true);
    const result = await midenClientProxy.sendTransaction(
      sendTx() as any,
      jest.fn(async () => new Uint8Array())
    );
    expect(G.__px.inlineSendTransaction).toHaveBeenCalled();
    expect(result).toEqual({ __inlineSendResult: true });
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → dispatches a whole-op OFFSCREEN_CALL (minimal DTO, write deadline, criticalOp bracketed) + rehydrates', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const prover = await import('./offscreen-prover');
    let criticalDuring: boolean | undefined;
    let signCbSizeDuring: number | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      criticalDuring = prover.isCriticalOpInFlight();
      signCbSizeDuring = __test.opSignCallbacksSize();
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1, 2, 3]).toString('base64'), durationMs: 4 };
    });

    const p = midenClientProxy.sendTransaction(
      sendTx() as any,
      jest.fn(async () => new Uint8Array())
    );
    await flush();
    fireReady();
    const result = await p;

    // Never used the inline SW client, and NEVER held the SW WASM lock.
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.withWasmClientLock).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('sendTransaction');
    expect(env.deadline_ms).toBe(90_000);
    // The DTO carries only the fields sendTransaction reads — with the BigInt
    // amount shipped as a decimal STRING (never the BigInt-bearing tx).
    const sentDto = JSON.parse(env.argsB64[0].slice(2));
    expect(sentDto).toEqual({
      accountId: 'mtst1qacc',
      secondaryAccountId: 'mtst1qrecipient',
      faucetId: 'mtst1qfaucet',
      noteType: 'public',
      amount: '1000',
      delegateTransaction: false,
      extraInputs: { recallBlocks: 100 }
    });
    expect(criticalDuring).toBe(true);
    expect(signCbSizeDuring).toBe(1);
    expect(prover.isCriticalOpInFlight()).toBe(false);
    expect(__test.opSignCallbacksSize()).toBe(0);
    expect(G.__px.getWasmOrThrow).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ __txResult: [1, 2, 3] });
    expect(__test.inFlightSize()).toBe(0);
  });

  it('flag ON → a null offscreen result throws (a send must always yield a TransactionResult)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const p = midenClientProxy
      .sendTransaction(
        sendTx() as any,
        jest.fn(async () => new Uint8Array())
      )
      .catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('no TransactionResult bytes');
  });

  it('§5 kill: a wedged send (own deadline fires) rejects with OperationAbortedError → the loop marks it Failed', async () => {
    const { __test, markOpStarted } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const { op_id, promise } = __test.dispatchCritical('sendTransaction', [{}], 20);
    const p = promise.catch((e: Error) => e);
    await flush();
    fireReady();
    await flush();
    expect(__test.inFlightSize()).toBe(1);
    markOpStarted(op_id); // op wins the mutex + begins executing → deadline armed

    await wait(40); // trip the write's own deadline
    fireReady();
    await flush();

    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('deadline');
    expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(__test.inFlightSize()).toBe(0);
  });
});

// ─── PR #524 per-step send timings survive the rehost (OFFSCREEN_STAGE_EVENT) ──
//
// The staged send stamps `executing`/`proving`/`submitting` as it runs; the
// generating-transaction screen turns those stamps into a duration per step. The
// stamps are keyed by the DB ROW id, which the offscreen write DTO deliberately
// doesn't carry — so the callback is registered OP-SCOPED (exactly like the sign
// callback) and the offscreen realm's fire-and-forget OFFSCREEN_STAGE_EVENT is
// replayed through it. Both flag states must stamp: the SW build
// (vite.background.config.ts) is the one build that defaults the flag ON, so a
// callback that rode the inline leaf only would silently delete the timings on
// Chrome.
describe('MidenClientProxy — sendTransaction per-step stage stamps (PR #524)', () => {
  it('flag OFF → the stage callback is handed straight to the inline sendTransaction (the call the tx loop used to make itself)', async () => {
    const { midenClientProxy, __test } = await loadProxy(false);
    const stages: string[] = [];
    const onStage = jest.fn(async (s: string) => {
      stages.push(s);
    });
    // The inline client drives the callback exactly as the SDK's staged pipeline does.
    G.__px.inlineSendTransaction = jest.fn(async (_tx: any, cb?: (s: string) => Promise<void>) => {
      await cb?.('executing');
      await cb?.('proving');
      await cb?.('submitting');
      return { __inlineSendResult: true };
    });

    const tx = sendTx();
    const result = await midenClientProxy.sendTransaction(
      tx as any,
      jest.fn(async () => new Uint8Array([1])),
      onStage
    );

    expect(G.__px.inlineSendTransaction).toHaveBeenCalledWith(tx, onStage);
    expect(stages).toEqual(['executing', 'proving', 'submitting']);
    expect(result).toEqual({ __inlineSendResult: true });
    // Nothing offscreen: no op registered, no message, no doc.
    expect(__test.opStageCallbacksSize()).toBe(0);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → an OFFSCREEN_STAGE_EVENT for the in-flight op_id invokes the registered callback', async () => {
    const { midenClientProxy, handleOffscreenStageEvent, __test } = await loadProxy(true);
    const stages: string[] = [];
    const onStage = jest.fn(async (s: string) => {
      stages.push(s);
    });

    // Mid-op: the offscreen realm posts one stage event per step, tagged with the
    // op_id the SW minted at dispatch, then the write replies.
    let sizeDuring: number | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      sizeDuring = __test.opStageCallbacksSize();
      handleOffscreenStageEvent(env.op_id, 'executing');
      handleOffscreenStageEvent(env.op_id, 'proving');
      handleOffscreenStageEvent(env.op_id, 'submitting');
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1, 2, 3]).toString('base64'), durationMs: 4 };
    });

    const p = midenClientProxy.sendTransaction(
      sendTx() as any,
      jest.fn(async () => new Uint8Array()),
      onStage
    );
    await flush();
    fireReady();
    const result = await p;
    await flush(); // the callback is invoked without being awaited by the handler

    // The row-bound callback got every stamp, in order — the timings survive the
    // rehost even though the row id never crossed the boundary.
    expect(stages).toEqual(['executing', 'proving', 'submitting']);
    // Registered for exactly this op while it was in flight, and the write itself
    // is untouched (still the offscreen whole-op result).
    expect(sizeDuring).toBe(1);
    expect(result).toEqual({ __txResult: [1, 2, 3] });
    // The inline SW client was never involved.
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
  });

  it('a stage event for an unknown op_id is ignored silently (never throws)', async () => {
    const { handleOffscreenStageEvent, __test } = await loadProxy(true);
    // Never dispatched, so nothing is registered under this id.
    expect(() => handleOffscreenStageEvent('never-dispatched', 'proving')).not.toThrow();
    expect(__test.opStageCallbacksSize()).toBe(0);
  });

  it('the stage callback is deregistered once the op settles — a late stamp is a silent no-op', async () => {
    const { midenClientProxy, handleOffscreenStageEvent, __test } = await loadProxy(true);
    const onStage = jest.fn();
    let opId = '';
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      opId = env.op_id;
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1]).toString('base64'), durationMs: 1 };
    });

    const p = midenClientProxy.sendTransaction(
      sendTx() as any,
      jest.fn(async () => new Uint8Array()),
      onStage
    );
    await flush();
    fireReady();
    await p;

    // Torn down in the write's `finally`, on the same line as the sign callback.
    expect(__test.opStageCallbacksSize()).toBe(0);
    expect(__test.opSignCallbacksSize()).toBe(0);
    // A stamp that lost the race with the final response finds no entry: dropped,
    // not thrown, and the callback is never invoked after settle.
    expect(() => handleOffscreenStageEvent(opId, 'submitting')).not.toThrow();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('a throwing / rejecting stage callback never fails the write (the stamp is telemetry)', async () => {
    const { midenClientProxy, handleOffscreenStageEvent } = await loadProxy(true);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // One synchronous throw, one rejected promise — both non-fatal paths.
    const onStage = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('dexie write blew up');
      })
      .mockImplementationOnce(() => Promise.reject(new Error('dexie write rejected')));

    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      handleOffscreenStageEvent(env.op_id, 'executing');
      handleOffscreenStageEvent(env.op_id, 'proving');
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([5]).toString('base64'), durationMs: 1 };
    });

    const p = midenClientProxy.sendTransaction(
      sendTx() as any,
      jest.fn(async () => new Uint8Array()),
      onStage
    );
    await flush();
    fireReady();
    // The funds-moving write completes normally despite both failures.
    await expect(p).resolves.toEqual({ __txResult: [5] });
    await flush();
    expect(onStage).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('a write with NO stage callback registers nothing (consume/swap/newTransaction are unstaged)', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    let stageSizeDuring: number | undefined;
    let signSizeDuring: number | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      stageSizeDuring = __test.opStageCallbacksSize();
      signSizeDuring = __test.opSignCallbacksSize();
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1]).toString('base64'), durationMs: 1 };
    });

    const p = midenClientProxy.consumeNoteId(
      consumeTx() as any,
      jest.fn(async () => new Uint8Array())
    );
    await flush();
    fireReady();
    await p;

    // The sign callback is mandatory for every write; the stage stamp is opt-in.
    expect(signSizeDuring).toBe(1);
    expect(stageSizeDuring).toBe(0);
  });
});

describe('MidenClientProxy — slice-5b swapTransaction flag routing + byte-identity', () => {
  it('flag OFF → swapTransaction runs inline under withWasmClientLock with wrapped sign options (byte-identical)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const tx = swapTx();
    const result = await midenClientProxy.swapTransaction(tx as any, signCallback);

    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    const opts = G.__px.getMidenClient.mock.calls[0][0];
    expect(typeof opts.signCallback).toBe('function');
    expect(G.__px.inlineSwapTransaction).toHaveBeenCalledWith(tx);
    expect(result).toEqual({ __inlineSwapResult: true });
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON but no chrome.offscreen API → swapTransaction falls back inline', async () => {
    installChromeMock({ withOffscreen: false });
    const { midenClientProxy } = await loadProxy(true);
    const result = await midenClientProxy.swapTransaction(
      swapTx() as any,
      jest.fn(async () => new Uint8Array())
    );
    expect(G.__px.inlineSwapTransaction).toHaveBeenCalled();
    expect(result).toEqual({ __inlineSwapResult: true });
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → dispatches a whole-op OFFSCREEN_CALL with the swap DTO (both BigInt amounts as strings) + rehydrates', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const prover = await import('./offscreen-prover');
    let criticalDuring: boolean | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      criticalDuring = prover.isCriticalOpInFlight();
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([4, 5, 6]).toString('base64'), durationMs: 4 };
    });

    const p = midenClientProxy.swapTransaction(
      swapTx() as any,
      jest.fn(async () => new Uint8Array())
    );
    await flush();
    fireReady();
    const result = await p;

    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.withWasmClientLock).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('swapTransaction');
    expect(env.deadline_ms).toBe(90_000);
    // Offered amount AND requested amount both cross as decimal strings; the
    // display-only expirySeconds/autoConsume are NOT part of the DTO.
    const sentDto = JSON.parse(env.argsB64[0].slice(2));
    expect(sentDto).toEqual({
      accountId: 'mtst1qacc',
      faucetId: 'mtst1qoffered',
      amount: '500',
      delegateTransaction: false,
      extraInputs: { requestedFaucetId: 'mtst1qrequested', requestedAmount: '250' }
    });
    expect(criticalDuring).toBe(true);
    expect(prover.isCriticalOpInFlight()).toBe(false);
    expect(result).toEqual({ __txResult: [4, 5, 6] });
    expect(__test.inFlightSize()).toBe(0);
  });

  it('flag ON → a null offscreen result throws (a swap must always yield a TransactionResult)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const p = midenClientProxy
      .swapTransaction(
        swapTx() as any,
        jest.fn(async () => new Uint8Array())
      )
      .catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('no TransactionResult bytes');
  });
});

describe('MidenClientProxy — slice-5b newTransaction (execute) flag routing + byte-identity', () => {
  const reqBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

  it('flag OFF → newTransaction runs inline under withWasmClientLock with wrapped sign options (byte-identical)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const result = await midenClientProxy.newTransaction('mtst1qacc', reqBytes, false, signCallback);

    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    const opts = G.__px.getMidenClient.mock.calls[0][0];
    expect(typeof opts.signCallback).toBe('function');
    // Positional passthrough — accountId, requestBytes, delegateTransaction — verbatim.
    expect(G.__px.inlineNewTransaction).toHaveBeenCalledWith('mtst1qacc', reqBytes, false);
    expect(result).toEqual({ __inlineNewResult: true });
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON but no chrome.offscreen API → newTransaction falls back inline', async () => {
    installChromeMock({ withOffscreen: false });
    const { midenClientProxy } = await loadProxy(true);
    const result = await midenClientProxy.newTransaction(
      'mtst1qacc',
      reqBytes,
      undefined,
      jest.fn(async () => new Uint8Array())
    );
    expect(G.__px.inlineNewTransaction).toHaveBeenCalledWith('mtst1qacc', reqBytes, undefined);
    expect(result).toEqual({ __inlineNewResult: true });
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON → dispatches a whole-op OFFSCREEN_CALL with POSITIONAL args (requestBytes as raw bytes) + rehydrates', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const prover = await import('./offscreen-prover');
    let criticalDuring: boolean | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      criticalDuring = prover.isCriticalOpInFlight();
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([8, 9]).toString('base64'), durationMs: 4 };
    });

    const p = midenClientProxy.newTransaction(
      'mtst1qacc',
      reqBytes,
      true,
      jest.fn(async () => new Uint8Array())
    );
    await flush();
    fireReady();
    const result = await p;

    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.withWasmClientLock).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('newTransaction');
    expect(env.deadline_ms).toBe(90_000);
    // accountId (JSON) + requestBytes (RAW bytes, not JSON) + delegateTransaction (JSON).
    expect(env.argsB64[0]).toBe('s:"mtst1qacc"');
    expect(env.argsB64[1].startsWith('b:')).toBe(true);
    expect(Array.from(b64ToBytesLocal(env.argsB64[1].slice(2)))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(env.argsB64[2]).toBe('s:true');
    expect(criticalDuring).toBe(true);
    expect(prover.isCriticalOpInFlight()).toBe(false);
    expect(result).toEqual({ __txResult: [8, 9] });
    expect(__test.inFlightSize()).toBe(0);
  });

  it('flag ON → a null offscreen result throws (an execute must always yield a TransactionResult)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const p = midenClientProxy
      .newTransaction(
        'mtst1qacc',
        reqBytes,
        false,
        jest.fn(async () => new Uint8Array())
      )
      .catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('no TransactionResult bytes');
  });
});

/** Local base64→bytes for the argsB64 raw-bytes assertion (matches offscreen-codec). */
function b64ToBytesLocal(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ─── Slice 5b (funds-critical, #260): errorCode round-trips onto the rejection ─
//
// When a whole-op offscreen WRITE fails DETERMINISTICALLY (submit landed on chain
// but the local apply threw → `ApplyTransactionAfterSubmitFailed`), the offscreen
// reply carries the SDK's stable `errorCode`. The proxy MUST re-attach it to the
// rejection in the exact shape the SW tx classifier reads (`extractSdkErrorCode` →
// `err.errorCode`). If it doesn't, the classifier reads `undefined`, SKIPS the
// "mark Completed" branch, and falls through to cancel → Failed → REQUEUEABLE
// (send/consume/swap/execute) → user Retry re-executes against fresh state →
// DOUBLE-SPEND. All four writes share `dispatchOffscreenWrite`/`finishOp`, so one
// choke point must preserve the code for every one of them.
describe('MidenClientProxy — offscreen WRITE errorCode preservation (funds-critical #260)', () => {
  const APPLY = 'ApplyTransactionAfterSubmitFailed';

  const writeCases: Array<{ name: string; invoke: (p: any) => Promise<unknown> }> = [
    {
      name: 'sendTransaction',
      invoke: p =>
        p.sendTransaction(
          sendTx() as any,
          jest.fn(async () => new Uint8Array())
        )
    },
    {
      name: 'swapTransaction',
      invoke: p =>
        p.swapTransaction(
          swapTx() as any,
          jest.fn(async () => new Uint8Array())
        )
    },
    {
      name: 'consumeNoteId',
      invoke: p =>
        p.consumeNoteId(
          consumeTx() as any,
          jest.fn(async () => new Uint8Array())
        )
    },
    {
      name: 'newTransaction',
      invoke: p =>
        p.newTransaction(
          'mtst1qacc',
          new Uint8Array([0xde, 0xad]),
          false,
          jest.fn(async () => new Uint8Array())
        )
    }
  ];

  it.each(writeCases)(
    '$name: an ApplyTransactionAfterSubmitFailed offscreen reply rejects with an error the SW classifier reads as Completed (not Failed → requeue)',
    async ({ invoke }) => {
      const { midenClientProxy } = await loadProxy(true);
      // The REAL classifier extractor — asserting it returns the code proves the SW
      // takes the `=== 'ApplyTransactionAfterSubmitFailed'` → mark-Completed branch,
      // exactly as the flag-off inline path does.
      const { extractSdkErrorCode } = await import('../sdk/sdk-error-code');
      fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
        ok: false,
        op_id: env.op_id,
        error: 'local apply failed after submit',
        errorCode: APPLY
      }));

      const p = invoke(midenClientProxy).catch((e: unknown) => e);
      await flush();
      fireReady();
      const err = await p;

      // The offscreen error string is still surfaced on the message...
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('local apply failed after submit');
      // ...AND the stable code rides the rejection in the exact shape the classifier
      // reads → Completed, never Failed → requeue → double-spend.
      expect(extractSdkErrorCode(err)).toBe(APPLY);
    }
  );

  // Issue #775, the other half of the same funds-critical rule. An offscreen-realm
  // lock eviction has no error CODE — it is identified by its CLASS, and the SW's
  // kill classifiers (`cancelTransactionAfterPipelineStopped`'s may-have-submitted
  // crossing, `tryCompleteKilledConsume`'s node adjudication) key off exactly that.
  // Rebuilt as a bare `Error` it reads as an ordinary pre-submit failure, and for a
  // send that lets Retry mint a second payment while the abandoned offscreen op is
  // still able to submit.
  it.each(writeCases)(
    '$name: a poison-eviction offscreen reply rejects with a WasmClientPoisonedError, not a bare Error',
    async ({ invoke }) => {
      const { midenClientProxy } = await loadProxy(true);
      const { isWasmClientPoisonedError } = await import('../sdk/wasm-client-poison');
      fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
        ok: false,
        op_id: env.op_id,
        error: 'WASM client poisoned (realm-error): uncaught realm error while holding the WASM client lock',
        errorName: 'WasmClientPoisonedError',
        errorReason: 'realm-error'
      }));

      const p = invoke(midenClientProxy).catch((e: unknown) => e);
      await flush();
      fireReady();
      const err = await p;

      expect(isWasmClientPoisonedError(err)).toBe(true);
      expect((err as { reason?: string }).reason).toBe('realm-error');
    }
  );

  it('a poison reply whose errorReason is missing or garbled is still classified as an eviction', async () => {
    // The classification is what protects the funds; the mechanism name is only
    // diagnostic. An older or malformed payload must therefore degrade to "some
    // eviction happened", never to "an ordinary failure".
    const { midenClientProxy } = await loadProxy(true);
    const { isWasmClientPoisonedError } = await import('../sdk/wasm-client-poison');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: false,
      op_id: env.op_id,
      error: 'WASM client poisoned',
      errorName: 'WasmClientPoisonedError',
      errorReason: 'not-a-known-reason'
    }));

    const p = midenClientProxy
      .sendTransaction(
        sendTx() as any,
        jest.fn(async () => new Uint8Array())
      )
      .catch((e: unknown) => e);
    await flush();
    fireReady();
    const err = await p;

    expect(isWasmClientPoisonedError(err)).toBe(true);
    // Falls back to the mechanism that bounds every wedge.
    expect((err as { reason?: string }).reason).toBe('watchdog');
  });

  it('an ok:false reply with NO errorCode still rejects (abort/undefined-code path unchanged)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { extractSdkErrorCode } = await import('../sdk/sdk-error-code');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: false,
      op_id: env.op_id,
      error: 'generic offscreen failure'
    }));

    const p = midenClientProxy
      .sendTransaction(
        sendTx() as any,
        jest.fn(async () => new Uint8Array())
      )
      .catch((e: unknown) => e);
    await flush();
    fireReady();
    const err = await p;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('generic offscreen failure');
    // No code on the reply → none on the rejection (classifier falls through to
    // Failed, as it always has for a genuinely-failed pre-submit write).
    expect(extractSdkErrorCode(err)).toBeUndefined();
  });
});

// ─── Slice 6a: dispatchGuardianPipeline (the guardian write LEAF offscreen) ───
//
// A guardian tx's co-signature is contributed BEFORE execute, so the leaf that
// crosses is byte-for-byte the same op-shape as a non-guardian write — it reuses
// `dispatchOffscreenWrite` wholesale. These tests pin the guardian-specific waist:
// the `guardianPipeline` method name, the [accountId, trBytes, delegate,
// chainAnchorB64] DTO with
// the co-signed request crossing as RAW BYTES intact (§4.0), the shared write-deadline
// deadline + criticalOp bracketing, the reused OFFSCREEN_SIGN_REQUEST sign channel,
// the errorCode round-trip, and the retryable abort on a kill.
describe('MidenClientProxy — slice-6a dispatchGuardianPipeline (guardian leaf offscreen)', () => {
  const trBytes = () => new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);

  it('flag ON → dispatches a whole-op guardianPipeline OFFSCREEN_CALL (accountId + co-signed tr bytes intact + delegate, write deadline, criticalOp bracketed) + rehydrates', async () => {
    const { dispatchGuardianPipeline, __test } = await loadProxy(true);
    const prover = await import('./offscreen-prover');
    const { b64ToBytes } = await import('./offscreen-codec');
    let criticalDuring: boolean | undefined;
    let signCbSizeDuring: number | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      criticalDuring = prover.isCriticalOpInFlight();
      signCbSizeDuring = __test.opSignCallbacksSize();
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([5, 6, 7]).toString('base64'), durationMs: 4 };
    });

    const tr = trBytes();
    const p = dispatchGuardianPipeline(
      'mtst1qguardian',
      tr,
      false,
      jest.fn(async () => new Uint8Array())
    );
    await flush();
    fireReady();
    const result = await p;

    // Never used the inline SW client — and NEVER held the SW WASM lock (the
    // offscreen doc serializes, keeping the SW free + the sign handler unblocked).
    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.withWasmClientLock).not.toHaveBeenCalled();
    // Exactly one OFFSCREEN_CALL, method guardianPipeline, write deadline.
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('guardianPipeline');
    expect(env.deadline_ms).toBe(__test.writeDeadlineMs());
    expect(env.deadline_ms).toBe(90_000);
    // DTO: [accountId (s:string), trBytes (b:bytes), delegate (s:bool),
    // chainAnchorB64 (s:string|null)].
    expect(env.argsB64).toHaveLength(4);
    expect(env.argsB64[0]).toBe(`s:${JSON.stringify('mtst1qguardian')}`);
    expect(env.argsB64[2]).toBe('s:false');
    // §4.0: the co-signed request crossed as RAW BYTES, byte-for-byte intact —
    // NOT JSON-mangled — so the advice map carrying the co-signatures survives.
    expect(env.argsB64[1].startsWith('b:')).toBe(true);
    expect(Array.from(b64ToBytes(env.argsB64[1].slice(2)))).toEqual(Array.from(tr));
    // #784: no anchor passed here, and the slot is still present — `encodeArg`
    // maps it to the wire NULL rather than dropping it, so the offscreen
    // dispatch's positional parameters stay aligned.
    expect(env.argsB64[3]).toBe('s:null');
    // criticalOp + sign callback bracketed AROUND the op, cleaned up after.
    expect(criticalDuring).toBe(true);
    expect(signCbSizeDuring).toBe(1);
    expect(prover.isCriticalOpInFlight()).toBe(false);
    expect(__test.opSignCallbacksSize()).toBe(0);
    // SW re-hydrated the serialized TransactionResult (WASM ensured first).
    expect(G.__px.getWasmOrThrow).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ __txResult: [5, 6, 7] });
    expect(__test.inFlightSize()).toBe(0);
  });

  // #784: this crossing is the ONLY place the proposal's chain anchor is put on
  // the wire. Both sides of it are covered elsewhere — the caller by a mocked
  // `dispatchGuardianPipeline`, the offscreen dispatch by a hand-built envelope
  // — so without this the anchor could be dropped from the DTO entirely and
  // every other suite would stay green.
  it('#784: the proposal chain anchor crosses in the 4th DTO slot, as its wire-form base64', async () => {
    const { dispatchGuardianPipeline } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: Buffer.from([5, 6, 7]).toString('base64'),
      durationMs: 4
    }));

    const p = dispatchGuardianPipeline(
      'mtst1qguardian',
      trBytes(),
      false,
      jest.fn(async () => new Uint8Array()),
      undefined,
      'BwcH'
    );
    await flush();
    fireReady();
    await p;

    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.argsB64).toHaveLength(4);
    expect(env.argsB64[3]).toBe('s:"BwcH"');
  });

  it('flag ON → an ApplyTransactionAfterSubmitFailed reply rejects with the errorCode the GUARDIAN classifier reads (Completed, not Failed → requeue)', async () => {
    const { dispatchGuardianPipeline } = await loadProxy(true);
    const { extractSdkErrorCode } = await import('../sdk/sdk-error-code');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: false,
      op_id: env.op_id,
      error: 'local apply failed after submit',
      errorCode: 'ApplyTransactionAfterSubmitFailed'
    }));

    const p = dispatchGuardianPipeline(
      'acc',
      trBytes(),
      false,
      jest.fn(async () => new Uint8Array())
    ).catch((e: unknown) => e);
    await flush();
    fireReady();
    const err = await p;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('local apply failed after submit');
    // The stable code rides the rejection in the shape the guardian classifier reads.
    expect(extractSdkErrorCode(err)).toBe('ApplyTransactionAfterSubmitFailed');
  });

  it('flag ON → the executeRequest sign reverses through the op-registered callback over the EXISTING OFFSCREEN_SIGN_REQUEST channel', async () => {
    const { dispatchGuardianPipeline, handleOffscreenSignRequest, __test } = await loadProxy(true);
    const { bytesToB64 } = await import('./offscreen-codec');
    const opSign = jest.fn(async () => new Uint8Array([0xaa, 0xbb]));
    const fallback = jest.fn(async () => new Uint8Array([0xff]));

    let signResult: any;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      signResult = await handleOffscreenSignRequest(
        {
          target: 'sw',
          type: 'OFFSCREEN_SIGN_REQUEST',
          op_id: env.op_id,
          sign_id: 's-g',
          publicKeyB64: bytesToB64(new Uint8Array([0x01, 0x02])),
          signingInputsB64: bytesToB64(new Uint8Array([0x03, 0x04]))
        } as any,
        fallback
      );
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([9]).toString('base64'), durationMs: 1 };
    });

    const p = dispatchGuardianPipeline('acc', trBytes(), true, opSign);
    await flush();
    fireReady();
    await p;

    // The op's OWN callback signed (hex-converted args), never the fallback.
    expect(opSign).toHaveBeenCalledWith('0102', '0304');
    expect(fallback).not.toHaveBeenCalled();
    expect(signResult.ok).toBe(true);
    expect(Array.from(Buffer.from(signResult.signatureB64, 'base64'))).toEqual([0xaa, 0xbb]);
    expect(__test.opSignCallbacksSize()).toBe(0); // cleaned up
  });

  it('flag ON → a doc-closed kill rejects the guardian op with a retryable OperationAbortedError and clears the critical op', async () => {
    const { dispatchGuardianPipeline, __test } = await loadProxy(true);
    const prover = await import('./offscreen-prover');
    const { OperationAbortedError } = await import('./offscreen-codec');
    // The doc was reaped mid-op → sendMessage resolves undefined (design §3.1).
    fakeChrome.runtime.sendMessage.mockImplementation(async () => undefined);

    const p = dispatchGuardianPipeline(
      'acc',
      trBytes(),
      false,
      jest.fn(async () => new Uint8Array())
    ).catch((e: unknown) => e);
    await flush();
    fireReady();
    const err = await p;

    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('doc-closed');
    // Bookkeeping unwound: no lingering critical op, no in-flight entry.
    expect(prover.isCriticalOpInFlight()).toBe(false);
    expect(__test.inFlightSize()).toBe(0);
    expect(__test.opSignCallbacksSize()).toBe(0);
  });

  // PR #524 × slice 6a. Guardian is the wallet's DEFAULT account type and the SW
  // build defaults the flag ON, so the guardian leaf needs the same op-scoped stage
  // channel the non-guardian send got — without it the default send flow shows a
  // blank duration on every step.
  it('flag ON → forwards the stage callback op-scoped, and the leaf`s OFFSCREEN_STAGE_EVENTs replay through it', async () => {
    const { dispatchGuardianPipeline, handleOffscreenStageEvent, __test } = await loadProxy(true);
    const stages: string[] = [];
    const onStage = jest.fn(async (s: string) => {
      stages.push(s);
    });

    let sizeDuring: number | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      sizeDuring = __test.opStageCallbacksSize();
      // The offscreen guardianPipeline stamps the same three boundaries the inline
      // `runGuardianPipeline` does, each tagged with the op_id the SW minted here.
      handleOffscreenStageEvent(env.op_id, 'executing');
      handleOffscreenStageEvent(env.op_id, 'proving');
      handleOffscreenStageEvent(env.op_id, 'submitting');
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([5, 6, 7]).toString('base64'), durationMs: 4 };
    });

    const p = dispatchGuardianPipeline(
      'mtst1qguardian',
      trBytes(),
      false,
      jest.fn(async () => new Uint8Array()),
      onStage
    );
    await flush();
    fireReady();
    const result = await p;
    await flush(); // the handler invokes the callback without awaiting it

    expect(stages).toEqual(['executing', 'proving', 'submitting']);
    // Registered for exactly this op while in flight, torn down with the sign
    // callback on settle — and the write result itself is untouched.
    expect(sizeDuring).toBe(1);
    expect(__test.opStageCallbacksSize()).toBe(0);
    expect(result).toEqual({ __txResult: [5, 6, 7] });
  });

  it('flag ON → omitting the stage callback registers nothing (the guardian arg stays optional)', async () => {
    const { dispatchGuardianPipeline, __test } = await loadProxy(true);
    let stageSizeDuring: number | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      stageSizeDuring = __test.opStageCallbacksSize();
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1]).toString('base64'), durationMs: 1 };
    });

    const p = dispatchGuardianPipeline(
      'acc',
      trBytes(),
      false,
      jest.fn(async () => new Uint8Array())
    );
    await flush();
    fireReady();
    await p;

    expect(stageSizeDuring).toBe(0);
  });
});

// --- reloadOffscreenEndpointOverrides ---------------------------------------
//
// The override cache and the client singleton are BOTH module-scoped, so the SW's
// loadEndpointOverrides() + resetMidenClient() reach only the SW realm. Flag-on it
// is the OFFSCREEN client that talks to the node, so it needs its own nudge.
describe('MidenClientProxy — reloadOffscreenEndpointOverrides', () => {
  it('flag OFF → no-op even with a document open (the SW client is the one that talks to the node)', async () => {
    // A doc CAN exist flag-off (the offscreen prover uses one), so the flag is the
    // only thing that may keep the message from being sent here.
    docExists = true;
    const { reloadOffscreenEndpointOverrides } = await loadProxy(false);
    await expect(reloadOffscreenEndpointOverrides()).resolves.toBe(false);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('flag ON but no chrome.offscreen API → no-op (Firefox/Safari have no offscreen realm)', async () => {
    installChromeMock({ withOffscreen: false });
    const { reloadOffscreenEndpointOverrides } = await loadProxy(true);
    await expect(reloadOffscreenEndpointOverrides()).resolves.toBe(false);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON but NO document open → no-op, and does NOT create one (a fresh doc hydrates the override itself)', async () => {
    const { reloadOffscreenEndpointOverrides } = await loadProxy(true);
    await expect(reloadOffscreenEndpointOverrides()).resolves.toBe(false);
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('flag ON with a document open → sends OFFSCREEN_RELOAD_ENDPOINTS and reports the ack', async () => {
    docExists = true;
    const { reloadOffscreenEndpointOverrides } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async () => ({ ok: true }));

    await expect(reloadOffscreenEndpointOverrides()).resolves.toBe(true);

    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'OFFSCREEN_RELOAD_ENDPOINTS'
    });
    // Reuses the document it found — never respawns the realm.
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it('reports false when the offscreen realm answers ok:false', async () => {
    docExists = true;
    const { reloadOffscreenEndpointOverrides } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async () => ({ ok: false, error: 'storage exploded' }));
    await expect(reloadOffscreenEndpointOverrides()).resolves.toBe(false);
  });

  it('resolves false instead of throwing when the doc is reaped between the check and the send', async () => {
    docExists = true;
    const { reloadOffscreenEndpointOverrides } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockRejectedValue(new Error('message port closed'));
    // Must not reject: the replacement document loads the override at its own init,
    // so the caller (the RELOAD_ENDPOINT_OVERRIDES handler) has nothing to recover.
    await expect(reloadOffscreenEndpointOverrides()).resolves.toBe(false);
  });

  it('never tears down the realm — an in-flight critical write survives the reload', async () => {
    const { __test, reloadOffscreenEndpointOverrides } = await loadProxy(true);
    // The write never answers; only the reload does.
    fakeChrome.runtime.sendMessage.mockImplementation((env: any) =>
      env?.type === 'OFFSCREEN_RELOAD_ENDPOINTS' ? Promise.resolve({ ok: true }) : new Promise(() => {})
    );

    const { op_id, promise } = __test.dispatchCritical('sendTransaction', [{}], __test.writeDeadlineMs());
    void promise.catch(() => {});
    await flush();
    fireReady(); // ensureOffscreenDocument resolves → the doc is now open
    await flush();
    expect(__test.inFlightSize()).toBe(1);

    await expect(reloadOffscreenEndpointOverrides()).resolves.toBe(true);

    // This is the whole reason it is a message and not forceCloseOffscreenDocument():
    // no close, and the value-moving op is still in flight rather than aborted.
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(__test.inFlightSize()).toBe(1);
    expect(__test.inFlightOpIds()).toEqual([op_id]);
  });
});
