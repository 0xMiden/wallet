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

describe('MidenClientProxy — slice-5a consumeNoteId flag routing', () => {
  it('flag OFF → consumeNoteId runs inline under withWasmClientLock, the per-write signer unused', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const tx = consumeTx();
    const result = await midenClientProxy.consumeNoteId(tx as any, signCallback);
    expect(signCallback).not.toHaveBeenCalled();

    // The caller lock wraps the op (exactly as the old switch-under-lock did).
    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    // The write hands the lock nothing but the op, and asks for the singleton with no
    // options: no per-write signer anywhere, the realm's installed one signs (#878).
    expect(G.__px.withWasmClientLock.mock.calls[0]).toHaveLength(1);
    expect(G.__px.getMidenClient.mock.calls[0]).toHaveLength(0);
    // The inline client's consumeNoteId ran on the full tx object.
    expect(G.__px.inlineConsumeNoteId).toHaveBeenCalledWith(tx, undefined);
    expect(result).toEqual({ __inlineTxResult: true });
    // Offscreen never touched.
    expect(fakeChrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
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
    expect(env.deadline_ms).toBe(180_000);
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
      expect((err as any).facts).toEqual({
        started: false,
        deadline: { owner: 'own', timer: 'backstop', killer: 'write' }
      });
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
    expect((err as any).facts).toEqual({
      started: true,
      deadline: { owner: 'own', timer: 'started', killer: 'write' }
    });
    const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
    expect(snapshotCrashDiagnostics(err)).toMatchObject({
      offscreenDeadlineMethod: 'consumeNoteId',
      offscreenDeadlineStage: 'not_observed'
    });
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

  it('a deadline re-armed after a sign round-trip reports the resumed timer', async () => {
    const { handleOffscreenSignRequest, __test, markOpStarted } = await loadProxy(true);
    const { bytesToB64 } = await import('./offscreen-codec');
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], 20);
    const p = promise.catch((e: Error) => e);
    await flush();
    fireReady();
    await flush();
    markOpStarted(op_id);
    await handleOffscreenSignRequest(
      {
        target: 'sw',
        type: 'OFFSCREEN_SIGN_REQUEST',
        op_id,
        sign_id: 's',
        publicKeyB64: bytesToB64(new Uint8Array([1])),
        signingInputsB64: bytesToB64(new Uint8Array([2]))
      } as any,
      (async () => new Uint8Array([1])) as any
    );
    await wait(40); // the re-armed deadline fires
    fireReady();
    await flush();

    const err = await p;
    expect((err as any).reason).toBe('deadline');
    expect((err as any).facts).toEqual({
      started: true,
      deadline: { owner: 'own', timer: 'resumed', killer: 'write' }
    });
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
// Each mirrors the slice-5a consumeNoteId contract exactly: flag-OFF runs inline
// under withWasmClientLock on the realm's one client, signed by the realm signer
// (the per-write signCallback unused, #878); flag-ON is a whole-op OFFSCREEN_CALL (minimal DTO / raw bytes in,
// serialized TransactionResult out) run on the SHARED critical machinery (write-deadline
// deadline, criticalOp bracketing, op-scoped sign callback). The kill-window /
// sign-pause / read-downgrade matrix is the SAME shared `dispatchOp` path the
// slice-5a tests exercise via `__test.dispatchCritical` (method-agnostic); the
// per-method tests below prove the ROUTING, DTO field-set, the unused flag-OFF signer, and that
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
  extraInputs: {
    recallBlocks: 100,
    oneClick: {
      fundingDeadline: '2026-10-22T12:00:00.000Z',
      request: { deadline: '2026-10-22T12:00:00.000Z' },
      quote: { quote: { deadline: '2026-10-22T12:10:00.000Z' } }
    }
  },
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

describe('MidenClientProxy - slice-5b sendTransaction flag routing', () => {
  it('flag OFF → sendTransaction runs inline under withWasmClientLock, the per-write signer unused', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const tx = sendTx();
    const result = await midenClientProxy.sendTransaction(tx as any, signCallback);
    expect(signCallback).not.toHaveBeenCalled();

    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    // The write hands the lock nothing but the op, and asks for the singleton with no
    // options: no per-write signer anywhere, the realm's installed one signs (#878).
    expect(G.__px.withWasmClientLock.mock.calls[0]).toHaveLength(1);
    expect(G.__px.getMidenClient.mock.calls[0]).toHaveLength(0);
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
    expect(env.deadline_ms).toBe(180_000);
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
      extraInputs: {
        recallBlocks: 100,
        oneClick: {
          fundingDeadline: '2026-10-22T12:00:00.000Z',
          request: { deadline: '2026-10-22T12:00:00.000Z' },
          quote: { quote: { deadline: '2026-10-22T12:10:00.000Z' } }
        }
      }
    });
    expect(criticalDuring).toBe(true);
    expect(signCbSizeDuring).toBe(1);
    expect(prover.isCriticalOpInFlight()).toBe(false);
    expect(__test.opSignCallbacksSize()).toBe(0);
    expect(G.__px.getWasmOrThrow).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ __txResult: [1, 2, 3] });
    expect(__test.inFlightSize()).toBe(0);
  });

  it.each([
    ['signed request first', 20, 40],
    ['provider expiry first', 40, 20]
  ])(
    'preserves the %s cutoff through offscreen decoding and SDK consumption',
    async (_label, requestMinutes, providerMinutes) => {
      const requestDeadline = new Date(Date.now() + requestMinutes * 60_000).toISOString();
      const providerDeadline = new Date(Date.now() + providerMinutes * 60_000).toISOString();
      const fundingDeadline = requestMinutes < providerMinutes ? requestDeadline : providerDeadline;
      const { midenClientProxy } = await loadProxy(true);
      fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
        ok: true,
        op_id: env.op_id,
        resultB64: Buffer.from([1, 2, 3]).toString('base64'),
        durationMs: 1
      }));
      const tx = {
        ...sendTx(),
        delegateTransaction: true,
        extraInputs: {
          oneClick: {
            fundingDeadline,
            request: { deadline: requestDeadline },
            quote: { quote: { deadline: providerDeadline } }
          }
        }
      };
      const dispatched = midenClientProxy.sendTransaction(tx as any, jest.fn());
      await flush();
      fireReady();
      await dispatched;

      const envelope = fakeChrome.runtime.sendMessage.mock.calls[0]?.[0];
      expect(envelope?.method).toBe('sendTransaction');
      const decoded = decodeArg(envelope.argsB64[0]) as any;
      expect(decoded.amount).toBe('1000');
      expect(decoded.extraInputs.oneClick.fundingDeadline).toBe(fundingDeadline);
      expect(decoded.extraInputs.oneClick.quote.quote.deadline).toBe(providerDeadline);

      const controlledReceiver = new WebAssembly.RuntimeError('SDK receiver reached after the deadline contract');
      const { MidenClientInterface } = await import('../sdk/miden-client-interface');
      const consumer = MidenClientInterface.fromClient(
        {
          _withInnerWebClient: jest.fn(async () => {
            throw controlledReceiver;
          })
        } as any,
        'testnet'
      );
      const validDecoded = {
        ...decoded,
        extraInputs: {
          ...decoded.extraInputs,
          oneClick: { ...decoded.extraInputs.oneClick, request: { deadline: requestDeadline } }
        }
      };
      await expect(consumer.sendTransaction(validDecoded)).rejects.toBe(controlledReceiver);
      await expect(consumer.sendTransaction(decoded)).rejects.toBe(controlledReceiver);
    }
  );

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

  it('flag ON → the stage event forwards the evidence it carried, marked unreliable (#1081)', async () => {
    const { midenClientProxy, handleOffscreenStageEvent } = await loadProxy(true);
    const onStage = jest.fn(async () => {});
    const evidence = { transactionId: `0x${'a'.repeat(64)}`, refBlock: 7 };
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      handleOffscreenStageEvent(env.op_id, 'submitting', evidence);
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1, 2, 3]).toString('base64'), durationMs: 4 };
    });
    const p = midenClientProxy.consumeNoteId(
      consumeTx() as any,
      jest.fn(async () => new Uint8Array()),
      onStage
    );
    await flush();
    fireReady();
    await p;
    await flush();
    expect(onStage).toHaveBeenCalledWith('submitting', { reliable: false, evidence });
  });

  it('flag OFF → consume, swap and newTransaction hand the stage callback straight to the inline leaf (#1081)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const onStage = jest.fn(async () => {});
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const consume = consumeTx();
    const swap = swapTx();
    const requestBytes = new Uint8Array([1]);

    await midenClientProxy.consumeNoteId(consume as any, signCallback, onStage);
    await midenClientProxy.swapTransaction(swap as any, signCallback, onStage);
    await midenClientProxy.newTransaction('mtst1qacc', requestBytes, true, signCallback, onStage);

    expect(G.__px.inlineConsumeNoteId).toHaveBeenCalledWith(consume, onStage);
    expect(G.__px.inlineSwapTransaction).toHaveBeenCalledWith(swap, onStage, {
      scope: 'testnet|default',
      nativeAssetId: 'mtst1qfee',
      feeFaucetId: null,
      baseFee: 7n
    });
    expect(G.__px.inlineNewTransaction).toHaveBeenCalledWith('mtst1qacc', requestBytes, true, onStage);
  });

  it('flag ON → swap and newTransaction register the stage callback for their op (#1081)', async () => {
    const { midenClientProxy, handleOffscreenStageEvent } = await loadProxy(true);
    const onStage = jest.fn(async () => {});
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      handleOffscreenStageEvent(env.op_id, 'submitting', { refBlock: 3 });
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1]).toString('base64'), durationMs: 1 };
    });

    const swap = midenClientProxy.swapTransaction(
      swapTx() as any,
      jest.fn(async () => new Uint8Array()),
      onStage
    );
    await flush();
    fireReady();
    await swap;
    const execute = midenClientProxy.newTransaction(
      'mtst1qacc',
      new Uint8Array([1]),
      false,
      jest.fn(async () => new Uint8Array()),
      onStage
    );
    await flush();
    fireReady();
    await execute;
    await flush();

    expect(onStage).toHaveBeenCalledTimes(2);
    expect(onStage).toHaveBeenNthCalledWith(1, 'submitting', { reliable: false, evidence: { refBlock: 3 } });
    expect(onStage).toHaveBeenNthCalledWith(2, 'submitting', { reliable: false, evidence: { refBlock: 3 } });
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

  it('a write with NO stage callback registers nothing', async () => {
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

describe('MidenClientProxy — slice-5b swapTransaction flag routing', () => {
  it('resolves the fee context before taking the inline WASM lock', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const fee = { scope: 'testnet|queued-endpoint', nativeAssetId: 'mtst1qfee', feeFaucetId: null, baseFee: 7n };
    G.__px.readSwapFeeContext.mockResolvedValue(fee);
    const tx = {
      ...swapTx(),
      extraInputs: { ...swapTx().extraInputs, balanceScope: fee.scope }
    };

    await midenClientProxy.swapTransaction(
      tx as any,
      jest.fn(async () => new Uint8Array())
    );

    expect(G.__px.readSwapFeeContext).toHaveBeenCalledWith(fee.scope);
    expect(G.__px.readSwapFeeContext.mock.invocationCallOrder[0]).toBeLessThan(
      G.__px.withWasmClientLock.mock.invocationCallOrder[0]
    );
    expect(G.__px.inlineSwapTransaction).toHaveBeenCalledWith(tx, undefined, fee);
  });

  it('flag OFF → swapTransaction runs inline under withWasmClientLock, the per-write signer unused', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const tx = swapTx();
    const result = await midenClientProxy.swapTransaction(tx as any, signCallback);
    expect(signCallback).not.toHaveBeenCalled();

    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    // The write hands the lock nothing but the op, and asks for the singleton with no
    // options: no per-write signer anywhere, the realm's installed one signs (#878).
    expect(G.__px.withWasmClientLock.mock.calls[0]).toHaveLength(1);
    expect(G.__px.getMidenClient.mock.calls[0]).toHaveLength(0);
    expect(G.__px.inlineSwapTransaction).toHaveBeenCalledWith(tx, undefined, {
      scope: 'testnet|default',
      nativeAssetId: 'mtst1qfee',
      feeFaucetId: null,
      baseFee: 7n
    });
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
    const fee = { scope: 'testnet|queued-endpoint', nativeAssetId: 'mtst1qfee', feeFaucetId: null, baseFee: 7n };
    G.__px.readSwapFeeContext.mockResolvedValue(fee);
    const transaction = {
      ...swapTx(),
      extraInputs: { ...swapTx().extraInputs, balanceScope: 'testnet|queued-endpoint' }
    };
    let criticalDuring: boolean | undefined;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      criticalDuring = prover.isCriticalOpInFlight();
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([4, 5, 6]).toString('base64'), durationMs: 4 };
    });

    const p = midenClientProxy.swapTransaction(
      transaction as any,
      jest.fn(async () => new Uint8Array())
    );
    await flush();
    fireReady();
    const result = await p;

    expect(G.__px.getMidenClient).not.toHaveBeenCalled();
    expect(G.__px.withWasmClientLock).not.toHaveBeenCalled();
    const env = fakeChrome.runtime.sendMessage.mock.calls[0][0];
    expect(env.method).toBe('swapTransaction');
    expect(env.deadline_ms).toBe(180_000);
    // Offered amount AND requested amount both cross as decimal strings; the
    // display-only expirySeconds/autoConsume are NOT part of the DTO.
    const sentDto = JSON.parse(env.argsB64[0].slice(2));
    expect(sentDto).toEqual({
      accountId: 'mtst1qacc',
      faucetId: 'mtst1qoffered',
      amount: '500',
      delegateTransaction: false,
      extraInputs: {
        requestedFaucetId: 'mtst1qrequested',
        requestedAmount: '250',
        balanceScope: 'testnet|queued-endpoint'
      },
      swapFeeContext: { ...fee, baseFee: '7' }
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

describe('MidenClientProxy — slice-5b newTransaction (execute) flag routing', () => {
  const reqBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

  it('flag OFF → newTransaction runs inline under withWasmClientLock, the per-write signer unused', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const signCallback = jest.fn(async () => new Uint8Array([1]));
    const result = await midenClientProxy.newTransaction('mtst1qacc', reqBytes, false, signCallback);
    expect(signCallback).not.toHaveBeenCalled();

    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(G.__px.getMidenClient).toHaveBeenCalledTimes(1);
    // The write hands the lock nothing but the op, and asks for the singleton with no
    // options: no per-write signer anywhere, the realm's installed one signs (#878).
    expect(G.__px.withWasmClientLock.mock.calls[0]).toHaveLength(1);
    expect(G.__px.getMidenClient.mock.calls[0]).toHaveLength(0);
    // Positional passthrough — accountId, requestBytes, delegateTransaction — verbatim.
    expect(G.__px.inlineNewTransaction).toHaveBeenCalledWith('mtst1qacc', reqBytes, false, undefined);
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
    expect(G.__px.inlineNewTransaction).toHaveBeenCalledWith('mtst1qacc', reqBytes, undefined, undefined);
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
    expect(env.deadline_ms).toBe(180_000);
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
      const { extractLanded, extractSdkErrorCode } = await import('../sdk/sdk-error-code');
      fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
        ok: false,
        op_id: env.op_id,
        error: 'local apply failed after submit',
        errorCode: APPLY,
        errorLanded: { transactionId: '0xlanded', privateOutputNotes: 2 }
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
      expect(extractLanded(err)).toEqual({ transactionId: '0xlanded', privateOutputNotes: 2 });
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

  it('preserves a terminal history fee error across the offscreen boundary', async () => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: false,
      op_id: env.op_id,
      error: 'Guardian history fee metadata is unavailable',
      errorName: 'GuardianHistoryFeeUnavailableError'
    }));
    const result = midenClientProxy.decodeGuardianHistory('summary');
    await flush();
    fireReady();
    await expect(result).rejects.toMatchObject({ name: 'GuardianHistoryFeeUnavailableError' });
  });

  it('preserves a history fee lookup error across the offscreen boundary', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { GuardianHistoryFeeLookupError } = await import('../guardian/history-errors');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: false,
      op_id: env.op_id,
      error: 'Guardian history fee metadata is not available yet',
      errorName: 'GuardianHistoryFeeLookupError'
    }));
    const result = midenClientProxy.decodeGuardianHistory('summary');
    await flush();
    fireReady();
    await expect(result).rejects.toBeInstanceOf(GuardianHistoryFeeLookupError);
  });

  it('preserves a history data error across the offscreen boundary', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { GuardianHistoryDataError } = await import('../guardian/history-errors');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: false,
      op_id: env.op_id,
      error: 'Guardian summary is too large',
      errorName: 'GuardianHistoryDataError'
    }));
    const result = midenClientProxy.decodeGuardianHistory('summary').catch((reason: unknown) => reason);
    await flush();
    fireReady();
    const error = await result;
    expect({ name: (error as Error).name, message: (error as Error).message }).toEqual({
      name: 'GuardianHistoryDataError',
      message: 'Guardian summary is too large'
    });
    expect(error).toBeInstanceOf(GuardianHistoryDataError);
  });

  const summaryB64 = (text: string) => Buffer.from(text).toString('base64');
  const validSummary = { accountId: 'account', inputNotes: [], outputNotes: [] };
  const sharedNoteSummary = { ...validSummary, inputNotes: [{ id: 'note', assets: [], visibility: 'shared' }] };
  it.each<[string, string | null, 'data' | 'transport' | 'valid']>([
    ['text that is not JSON', summaryB64('{'), 'data'],
    ['JSON that fails the summary schema', summaryB64(JSON.stringify(sharedNoteSummary)), 'data'],
    ['no summary', null, 'transport'],
    ['a valid summary', summaryB64(JSON.stringify(validSummary)), 'valid']
  ])('settles an ok history decode reply carrying %s by what failed', async (_label, resultB64, kind) => {
    const { midenClientProxy } = await loadProxy(true);
    const { GuardianHistoryDataError } = await import('../guardian/history-errors');
    const outcomes = {
      data: { name: 'GuardianHistoryDataError', message: 'Guardian summary fails its schema' },
      transport: { name: 'Error', message: 'Missing Guardian summary response' },
      valid: validSummary
    };
    const classes = { data: GuardianHistoryDataError, transport: Error, valid: Object };
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: true,
      op_id: env.op_id,
      resultB64,
      durationMs: 1
    }));
    const result = midenClientProxy.decodeGuardianHistory('summary').catch((reason: unknown) => reason);
    await flush();
    fireReady();
    const settled = await result;
    expect(settled instanceof Error ? { name: settled.name, message: settled.message } : settled).toEqual(
      outcomes[kind]
    );
    expect(settled).toBeInstanceOf(classes[kind]);
  });

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

