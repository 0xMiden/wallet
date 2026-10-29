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

import { decodeArg } from './offscreen-codec';

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
    expect(env.deadline_ms).toBe(180_000);
    // DTO: accountId, proof bytes, delegate, compatibility anchor, deadline, required flag.
    expect(env.argsB64).toHaveLength(6);
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
    expect(env.argsB64[4]).toBe('s:null');
    expect(env.argsB64[5]).toBe('s:false');
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

  // #784: wire compatibility only. The offscreen leaf reads nothing from the
  // 4th slot, but the packer still fills it with the value it is handed, and
  // this is the one test that drives the packer with a value: the caller is
  // covered by a mocked `dispatchGuardianPipeline`, the leaf by hand-built envelopes.
  it('#784: the retained 4th DTO slot carries the anchor base64 unchanged (wire compatibility only)', async () => {
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
    expect(env.argsB64).toHaveLength(6);
    expect(env.argsB64[3]).toBe('s:"BwcH"');
    expect(env.argsB64[4]).toBe('s:null');
    expect(env.argsB64[5]).toBe('s:false');
  });

  it('flag ON → an ApplyTransactionAfterSubmitFailed reply rejects with the errorCode the GUARDIAN classifier reads (Completed, not Failed → requeue)', async () => {
    const { dispatchGuardianPipeline } = await loadProxy(true);
    const { extractLanded, extractSdkErrorCode } = await import('../sdk/sdk-error-code');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: false,
      op_id: env.op_id,
      error: 'local apply failed after submit',
      errorCode: 'ApplyTransactionAfterSubmitFailed',
      errorLanded: { transactionId: '0xlanded', privateOutputNotes: 2 }
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
    expect(extractLanded(err)).toEqual({ transactionId: '0xlanded', privateOutputNotes: 2 });
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
// The offscreen document has no extension storage, so the network it runs on is the one these messages carry (#1482).
// #1644: the Guardian leaf's submit gate opens only for an op this worker still runs, after the leaf recorded the
// crossing, so a leaf the worker never let through never submits.
describe('MidenClientProxy — the Guardian leaf submit gate (#1644)', () => {
  const trBytes = () => new Uint8Array([0xca, 0xfe]);
  const gateReq = (op_id: string, evidence?: unknown) =>
    ({
      target: 'sw',
      type: 'OFFSCREEN_SUBMIT_GATE',
      op_id,
      evidence,
      recovery: { requestBytes: [1], notes: [] }
    }) as never;

  it('opens for the in-flight op once its gate recorded the crossing, with the evidence the leaf read', async () => {
    const { dispatchGuardianPipeline, handleOffscreenSubmitGate } = await loadProxy(true);
    const submitGate = jest.fn(async () => true);
    let answer: unknown;
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      answer = await handleOffscreenSubmitGate(gateReq(env.op_id, { refBlock: 4 }));
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1]).toString('base64'), durationMs: 1 };
    });
    const p = dispatchGuardianPipeline(
      'acc',
      trBytes(),
      false,
      jest.fn(async () => new Uint8Array()),
      undefined,
      undefined,
      submitGate
    );
    await flush();
    fireReady();
    await p;
    expect(submitGate).toHaveBeenCalledWith({ refBlock: 4 }, { requestBytes: new Uint8Array([1]), notes: [] });
    expect(answer).toEqual({ ok: true });
  });

  it('refuses when the leaf has already settled or could not record the crossing', async () => {
    const { dispatchGuardianPipeline, handleOffscreenSubmitGate } = await loadProxy(true);
    const answers: unknown[] = [];
    const gates = [jest.fn(async () => false), jest.fn(async () => Promise.reject(new Error('IndexedDB closed')))];
    for (const submitGate of gates) {
      fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
        answers.push(await handleOffscreenSubmitGate(gateReq(env.op_id)));
        return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1]).toString('base64'), durationMs: 1 };
      });
      const p = dispatchGuardianPipeline(
        'acc',
        trBytes(),
        false,
        jest.fn(async () => new Uint8Array()),
        undefined,
        undefined,
        submitGate
      );
      await flush();
      fireReady();
      // eslint-disable-next-line no-await-in-loop
      await p;
    }
    expect(answers).toEqual([
      expect.objectContaining({ ok: false }),
      expect.objectContaining({ ok: false, error: expect.stringContaining('IndexedDB closed') })
    ]);
  });

  it('refuses an op that is no longer in flight, and never asks its gate', async () => {
    const { dispatchGuardianPipeline, handleOffscreenSubmitGate } = await loadProxy(true);
    const submitGate = jest.fn(async () => true);
    let opId = '';
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => {
      opId = env.op_id;
      return { ok: true, op_id: env.op_id, resultB64: Buffer.from([1]).toString('base64'), durationMs: 1 };
    });
    const p = dispatchGuardianPipeline(
      'acc',
      trBytes(),
      false,
      jest.fn(async () => new Uint8Array()),
      undefined,
      undefined,
      submitGate
    );
    await flush();
    fireReady();
    await p;
    expect(await handleOffscreenSubmitGate(gateReq(opId))).toEqual(expect.objectContaining({ ok: false }));
    expect(await handleOffscreenSubmitGate(gateReq('never-dispatched'))).toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(submitGate).not.toHaveBeenCalled();
  });
});

describe('MidenClientProxy - the endpoint state on every offscreen message (#1482)', () => {
  const customOverride = async () => {
    const { buildDefaultOverrideFor } = await import('lib/miden-chain/effective-endpoints');
    const { MIDEN_NETWORK_NAME } = await import('lib/miden-chain/networks-config');
    return {
      ...buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET),
      rpcUrl: 'https://custom.example/rpc',
      feeFaucetId: '0xfee'
    };
  };

  it('attaches the state as it is when the message is sent, to a read and to a write', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const { applyEndpointOverride } = await import('lib/miden-chain/effective-endpoints');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));

    const read = midenClientProxy.getAccount('acc');
    await flush();
    // Saved while the document was still opening: the read goes out on the saved network.
    const override = await customOverride();
    await applyEndpointOverride(override);
    fireReady();
    await read;
    const { promise } = __test.dispatchCritical('sendTransaction', [{}], __test.writeDeadlineMs());
    await promise;

    const envelopes = fakeChrome.runtime.sendMessage.mock.calls.map(([env]: [any]) => env);
    expect(envelopes.map((env: any) => env.method)).toEqual(['getAccount', 'sendTransaction']);
    for (const env of envelopes) {
      expect(env.endpoints).toEqual({ override, feeFaucetId: '0xfee' });
    }
  });

  // The `miden-sync` alarm can reach a call before start() has loaded the override (#1482).
  it('sends no call until the realm has loaded its own override, then sends that override', async () => {
    const { midenClientProxy } = await loadProxy(true, { overridesLoaded: false });
    const endpoints = await import('lib/miden-chain/effective-endpoints');
    const { getStorageProvider } = await import('lib/platform/storage-adapter');
    const { MIDEN_NETWORK_NAME } = await import('lib/miden-chain/networks-config');
    const stored = endpoints.buildNetworkChoiceOverride(MIDEN_NETWORK_NAME.MAINNET);
    await getStorageProvider().set({ [endpoints.ENDPOINT_OVERRIDE_STORAGE_KEY]: stored });
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: any) => ({
      ok: true,
      op_id: env.op_id,
      resultB64: null,
      durationMs: 1
    }));
    const calls = () =>
      fakeChrome.runtime.sendMessage.mock.calls
        .map(([env]: [any]) => env)
        .filter((env: any) => env?.type === 'OFFSCREEN_CALL');

    const read = midenClientProxy.getAccount('acc');
    await flush();
    fireReady();
    await flush();
    expect(calls()).toHaveLength(0);

    await endpoints.loadEndpointOverrides();
    await read;
    expect(calls()).toHaveLength(1);
    expect(calls()[0].endpoints.override).toEqual(stored);
  });

  it('sends no reload until the realm has loaded its own override, then sends the loaded state', async () => {
    docExists = true;
    const { reloadOffscreenEndpointOverrides } = await loadProxy(true, { overridesLoaded: false });
    const endpoints = await import('lib/miden-chain/effective-endpoints');
    const { getStorageProvider } = await import('lib/platform/storage-adapter');
    const stored = await customOverride();
    await getStorageProvider().set({ [endpoints.ENDPOINT_OVERRIDE_STORAGE_KEY]: stored });
    fakeChrome.runtime.sendMessage.mockImplementation(async () => ({ ok: true }));

    const reload = reloadOffscreenEndpointOverrides();
    await flush();
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();

    await endpoints.loadEndpointOverrides();
    await expect(reload).resolves.toBe(true);
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'OFFSCREEN_RELOAD_ENDPOINTS',
      endpoints: { override: stored, feeFaucetId: '0xfee' }
    });
  });

  it('sends the state with the reload, so a live document switches without reading storage', async () => {
    docExists = true;
    const { reloadOffscreenEndpointOverrides } = await loadProxy(true);
    const { applyEndpointOverride } = await import('lib/miden-chain/effective-endpoints');
    const override = await customOverride();
    await applyEndpointOverride(override);
    fakeChrome.runtime.sendMessage.mockImplementation(async () => ({ ok: true }));

    await expect(reloadOffscreenEndpointOverrides()).resolves.toBe(true);
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'OFFSCREEN_RELOAD_ENDPOINTS',
      endpoints: { override, feeFaucetId: '0xfee' }
    });
  });
});

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

  it('flag ON but NO document open → no-op, and does NOT create one (a later doc gets the state with its first call)', async () => {
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
      type: 'OFFSCREEN_RELOAD_ENDPOINTS',
      endpoints: { override: null, feeFaucetId: undefined }
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
    // Must not reject: the replacement document gets the state with its first call,
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

describe('the errorBeforeSubmit tag across the bus (#1081)', () => {
  it('rebuilds a tagged reply as a tagged error, and an untagged one untagged', async () => {
    const { __test } = await loadProxy(true);
    const { hasErrorBeforeSubmit } = await import('lib/miden/sdk/sdk-error-code');
    fakeChrome.runtime.sendMessage.mockImplementationOnce(async (env: any) => ({
      ok: false,
      op_id: env.op_id,
      error: 'pre',
      errorBeforeSubmit: true
    }));
    const tagged = __test.dispatchCritical('sendTransaction', [{}], null).promise.catch((e: unknown) => e);
    await flush();
    fireReady();
    expect(hasErrorBeforeSubmit(await tagged)).toBe(true);
    fakeChrome.runtime.sendMessage.mockImplementationOnce(async (env: any) => ({
      ok: false,
      op_id: env.op_id,
      error: 'post'
    }));
    const untagged = __test.dispatchCritical('sendTransaction', [{}], null).promise.catch((e: unknown) => e);
    await flush();
    expect(hasErrorBeforeSubmit(await untagged)).toBe(false);
  });

  it('never tags a rebuilt eviction', async () => {
    const { __test } = await loadProxy(true);
    const { hasErrorBeforeSubmit } = await import('lib/miden/sdk/sdk-error-code');
    fakeChrome.runtime.sendMessage.mockImplementationOnce(async (env: any) => ({
      ok: false,
      op_id: env.op_id,
      error: 'evicted',
      errorName: 'WasmClientPoisonedError',
      errorBeforeSubmit: true
    }));
    const poisoned = __test.dispatchCritical('sendTransaction', [{}], null).promise.catch((e: unknown) => e);
    await flush();
    fireReady();
    expect(hasErrorBeforeSubmit(await poisoned)).toBe(false);
  });

  it('a document that cannot be opened fails tagged and registers nothing', async () => {
    const { __test } = await loadProxy(true);
    const { hasErrorBeforeSubmit } = await import('lib/miden/sdk/sdk-error-code');
    fakeChrome.offscreen.createDocument.mockRejectedValueOnce(new Error('cannot create the document'));
    const failed = await __test.dispatchCritical('sendTransaction', [{}], 20).promise.catch((e: unknown) => e);
    expect(hasErrorBeforeSubmit(failed)).toBe(true);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(__test.inFlightSize()).toBe(0);
  });

  it('an argument that cannot be encoded fails tagged, registers nothing, and kills no concurrent write', async () => {
    jest.useFakeTimers();
    try {
      const { __test } = await loadProxy(true);
      const { hasErrorBeforeSubmit } = await import('lib/miden/sdk/sdk-error-code');
      fakeChrome.runtime.sendMessage.mockImplementation(() => new Promise(() => {}));
      // No deadline, so no timer of its own: only a stale op's backstop could settle it.
      const live = __test.dispatchCritical('sendTransaction', [{}], null);
      let liveSettled = false;
      live.promise.then(
        () => (liveSettled = true),
        () => (liveSettled = true)
      );
      // The first dispatch opens the document and waits for its ready signal.
      await jest.advanceTimersByTimeAsync(0);
      fireReady();
      await jest.advanceTimersByTimeAsync(0);
      const failed = await __test
        .dispatchCritical('sendTransaction', [{ amount: 1n }], 20)
        .promise.catch((e: unknown) => e);
      expect(hasErrorBeforeSubmit(failed)).toBe(true);
      expect(__test.inFlightOpIds()).toEqual([live.op_id]);
      await jest.advanceTimersByTimeAsync(__test.criticalDispatchBackstopMs() + 1);
      expect(liveSettled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('closed execution error transport', () => {
  it.each(['unknown_value', 'wrong_route', 'throwing_getter'])(
    'ignores %s metadata and preserves the reconstructed failure',
    async kind => {
      const { midenClientProxy } = await loadProxy(true);
      fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => {
        const payload = {
          executionRoute: kind === 'wrong_route' ? 'guardian_signed_request' : 'ordinary_new_transaction',
          authObservation: 'observed',
          authArgPresence: 'present',
          authLayout: 'fee',
          commitmentMatch: kind === 'unknown_value' ? 'private 0xabcdef' : 'fee',
          accountAuthCode: 'unavailable'
        };
        const response = {
          ok: false,
          op_id: env.op_id,
          error: 'unchanged original rejection',
          errorTransactionExecution: payload
        };
        if (kind === 'throwing_getter')
          Object.defineProperty(response, 'errorTransactionExecution', {
            get: () => {
              throw new Error('private diagnostic getter');
            }
          });
        return response;
      });
      const running = midenClientProxy
        .newTransaction('acct', new Uint8Array([1, 2]), false, async () => new Uint8Array())
        .catch(error => error);
      await flush();
      fireReady();
      const error: unknown = await running;
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: "Offscreen call 'newTransaction' failed: unchanged original rejection" });
      const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
      expect(snapshotCrashDiagnostics(error)).toEqual({});
    }
  );

  it.each([true, false])('binds execution observations to the response op (matched: %s)', async matched => {
    const { midenClientProxy } = await loadProxy(true);
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: false,
      op_id: matched ? env.op_id : 'an-old-op',
      error: 'private original failure account 0xabcdef',
      errorTransactionExecution: {
        executionRoute: 'ordinary_new_transaction',
        authObservation: 'observed',
        authArgPresence: 'present',
        authLayout: 'missing_preimage',
        commitmentMatch: 'unavailable',
        accountAuthCode: 'unavailable',
        rawRequest: 'private request bytes'
      }
    }));
    const running = midenClientProxy
      .newTransaction('acct', new Uint8Array([1, 2]), false, async () => new Uint8Array())
      .catch(error => error);
    await flush();
    fireReady();
    const error: unknown = await running;
    const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
    expect(snapshotCrashDiagnostics(error)).toEqual(
      matched
        ? {
            executionRoute: 'ordinary_new_transaction',
            authObservation: 'observed',
            authArgPresence: 'present',
            authLayout: 'missing_preimage',
            commitmentMatch: 'unavailable',
            accountAuthCode: 'unavailable'
          }
        : {}
    );
    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});

it('ignores otherwise valid execution metadata for an unrelated response method', async () => {
  const { __test } = await loadProxy(true);
  fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
    ok: false,
    op_id: env.op_id,
    error: 'original send rejection',
    errorTransactionExecution: {
      executionRoute: 'ordinary_new_transaction',
      authObservation: 'observed',
      authArgPresence: 'present',
      authLayout: 'fee',
      commitmentMatch: 'fee',
      accountAuthCode: 'unavailable'
    }
  }));
  const running = __test.dispatchCritical('sendTransaction', [{}], null).promise.catch((error: unknown) => error);
  await flush();
  fireReady();
  const error = await running;
  expect(error).toMatchObject({ message: "Offscreen call 'sendTransaction' failed: original send rejection" });
  const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
  expect(snapshotCrashDiagnostics(error)).toEqual({});
});

it('a deadline and late valid execution payload cannot decorate the abort or its successor', async () => {
  jest.useFakeTimers();
  try {
    const { __test, markOpStarted } = await loadProxy(true);
    const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
    const { OperationAbortedError } = await import('./offscreen-codec');
    const pending: Array<(response: unknown) => void> = [];
    fakeChrome.runtime.sendMessage.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const expired = __test.dispatchCritical('newTransaction', ['acct', new Uint8Array([1]), false], 20);
    const expiredResult = expired.promise.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    fireReady();
    await jest.advanceTimersByTimeAsync(0);
    markOpStarted(expired.op_id);
    await jest.advanceTimersByTimeAsync(21);
    fireReady();
    await jest.advanceTimersByTimeAsync(0);
    const abort = await expiredResult;
    expect(abort).toBeInstanceOf(OperationAbortedError);
    expect(snapshotCrashDiagnostics(abort)).toEqual({
      offscreenDeadlineMethod: 'newTransaction',
      offscreenDeadlineStage: 'not_observed'
    });
    const successor = __test.dispatchCritical('newTransaction', ['acct', new Uint8Array([2]), false], null);
    let settled = false;
    const successorResult = successor.promise.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await jest.advanceTimersByTimeAsync(0);
    const oldReply = pending[0];
    if (!oldReply) throw new Error('old operation never dispatched');
    oldReply({
      ok: false,
      op_id: expired.op_id,
      error: 'late original failure',
      errorTransactionExecution: {
        executionRoute: 'ordinary_new_transaction',
        authObservation: 'observed',
        authArgPresence: 'present',
        authLayout: 'fee',
        commitmentMatch: 'fee',
        accountAuthCode: 'unavailable'
      }
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(__test.inFlightSize()).toBe(1);
    expect(snapshotCrashDiagnostics(abort)).toEqual({
      offscreenDeadlineMethod: 'newTransaction',
      offscreenDeadlineStage: 'not_observed'
    });
    const currentReply = pending[1];
    if (!currentReply) throw new Error('successor never dispatched');
    currentReply({ ok: false, op_id: successor.op_id, error: 'current original failure' });
    await jest.advanceTimersByTimeAsync(0);
    const error = await successorResult;
    expect(error).toMatchObject({ message: "Offscreen call 'newTransaction' failed: current original failure" });
    expect(snapshotCrashDiagnostics(error)).toEqual({});
    expect(__test.inFlightSize()).toBe(0);
    expect(fakeChrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

describe('Task4C3G5 canonical recovery read routing', () => {
  function material() {
    const family: import('../recovery/types').RecoveryNoteEntry = {
      kind: 'note',
      id: '34'.repeat(32),
      detailsId: '34'.repeat(32),
      noteFile: new Uint8Array([19, 48, 80]),
      provenance: 'input',
      format: 'details',
      candidates: [{ id: '12'.repeat(32), noteFile: new Uint8Array([19, 48, 81]), provenance: 'input', format: 'full' }]
    };
    const canonical = {
      familyId: family.id,
      id: '12'.repeat(32),
      detailsId: family.detailsId,
      noteFile: new Uint8Array([19, 48, 81])
    };
    return {
      family,
      canonical,
      snapshot: {
        generation: 'sdk-route',
        accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }],
        notes: [],
        canonicalNotes: [canonical]
      }
    };
  }

  async function offscreenRead(change: 'none' | 'foreign family' | 'extra field' | 'oversized' = 'none') {
    const { midenClientProxy } = await loadProxy(true);
    const health = await import('lib/miden/storage-health');
    await health.initializeStorageHealth();
    expect(health.getStorageHealth().status).toBe('healthy');
    const { toSerializable } = await import('../recovery/serialization');
    const data = material();
    if (change === 'foreign family') data.canonical.familyId = '56'.repeat(32);
    if (change === 'extra field') Reflect.set(data.canonical, 'authenticated', true);
    if (change === 'oversized') data.canonical.noteFile = new Uint8Array(2 * 1024 * 1024 + 1);
    fakeChrome.runtime.sendMessage.mockImplementation(async (envelope: { op_id: string }) => ({
      ok: true,
      op_id: envelope.op_id,
      resultB64: Buffer.from(JSON.stringify(toSerializable(data.snapshot))).toString('base64'),
      durationMs: 0
    }));
    const addListener = fakeChrome.runtime.onMessage.addListener.getMockImplementation();
    let signalReady = () => {};
    const registered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Canonical route ready listener was not registered')), 1000);
      signalReady = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    fakeChrome.runtime.onMessage.addListener.mockImplementation((listener: OnMessageListener) => {
      addListener(listener);
      signalReady();
    });
    const pending = Promise.resolve(
      Reflect.apply(midenClientProxy.readStorageContinuity, midenClientProxy, [
        ['retained'],
        false,
        undefined,
        [],
        [data.family]
      ])
    ).then(
      value => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    await registered;
    expect(fakeChrome.runtime.onMessage.addListener).toHaveBeenCalled();
    fireReady();
    return { data, outcome: await pending, health, toSerializable };
  }

  it('forwards canonical families through the actual inline proxy under its caller hold', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const health = await import('lib/miden/storage-health');
    await health.initializeStorageHealth();
    expect(health.getStorageHealth().status).toBe('healthy');
    const { withWasmClientLock, getCurrentWasmLockHold } = await import('lib/miden/sdk/miden-client');
    const data = material();
    let observedHold: unknown;
    const read = jest.fn(async (_accounts: string[], _include: boolean, assertLive: () => void) => {
      assertLive();
      observedHold = getCurrentWasmLockHold();
      return data.snapshot;
    });
    G.__px.getMidenClient.mockResolvedValue({ readStorageContinuity: read });
    let callerHold: unknown;
    const result = await withWasmClientLock(async hold => {
      callerHold = hold;
      return Reflect.apply(midenClientProxy.readStorageContinuity, midenClientProxy, [
        ['retained'],
        false,
        undefined,
        [],
        [data.family]
      ]);
    });
    expect(read).toHaveBeenCalledWith(['retained'], false, expect.any(Function), [], [data.family]);
    expect(result).toEqual(data.snapshot);
    expect(observedHold).toBe(callerHold);
    expect(G.__px.withWasmClientLock).toHaveBeenCalledTimes(1);
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('serializes the canonical family option in the existing offscreen operation', async () => {
    const { data, outcome, toSerializable } = await offscreenRead();
    expect(outcome.error).toBeUndefined();
    const envelope = fakeChrome.runtime.sendMessage.mock.calls.find(
      ([message]: [{ method?: string }]) => message.method === 'readStorageContinuity'
    )?.[0];
    expect(envelope?.argsB64.map(decodeArg)).toEqual([['retained'], false, [], toSerializable([data.family])]);
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it('preserves canonical full bytes in the owned offscreen response', async () => {
    const { data, outcome } = await offscreenRead();
    expect(outcome).toEqual({ value: data.snapshot, error: undefined });
  });

  const refusedResponses: Array<'foreign family' | 'extra field' | 'oversized'> = [
    'foreign family',
    'extra field',
    'oversized'
  ];
  it.each(refusedResponses)('refuses a %s canonical response without changing storage health', async change => {
    const { outcome, health } = await offscreenRead(change);
    expect(outcome.error).toBeDefined();
    expect(health.getStorageHealth().status).toBe('healthy');
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });
});

describe('Task4C3N offscreen retained-note receipt authority', () => {
  async function fixture({ registered = true } = {}) {
    const proxy = await loadProxy(true);
    const health = await import('../storage-health');
    const acquisition = await import('../recovery/note-acquisition');
    const { withRetainedNoteReceipt } = await import('../recovery/native-note-receipt');
    const { toSerializable } = await import('../recovery/serialization');
    const endpoints = await import('lib/miden-chain/effective-endpoints');
    const core = jest.requireActual<typeof import('../sdk/miden-client')>('../sdk/miden-client');
    await health.initializeStorageHealth();
    expect(health.getStorageHealth().status).toBe('healthy');
    docExists = true;
    const retainedBytes = new Uint8Array([19, 48, 111]);
    const canonicalBytes = new Uint8Array([19, 48, 112]);
    const note: import('../recovery/types').RecoveryNoteEntry = {
      kind: 'note',
      id: 'ab'.repeat(32),
      detailsId: 'cd'.repeat(32),
      noteFile: retainedBytes,
      provenance: 'input',
      format: 'full'
    };
    const body = {
      metadata: () => ({
        sender: () => ({ toString: () => '0x' + '11'.repeat(15), free: () => {} }),
        noteType: () => 0,
        tag: () => ({ asU32: () => 7, free: () => {} }),
        free: () => {}
      }),
      recipient: () => ({ digest: () => ({ toFelts: () => [] }) }),
      assets: () => ({ assets: () => [] }),
      free: () => {}
    };
    G.__px.retainedNoteFileDeserialize = jest.fn(() => ({
      note: () => body,
      noteDetails: () => undefined,
      noteId: () => ({ toString: () => '0x' + note.id, free: () => {} }),
      nullifier: () => '0x' + 'ef'.repeat(32),
      noteTag: () => undefined,
      afterBlockNum: () => undefined,
      serialize: () => canonicalBytes.slice(),
      free: () => {}
    }));
    G.__px.retainedDetailsCommitment = jest.fn(() => ({
      toHex: () => '0x' + note.detailsId,
      toFelts: () => [],
      free: () => {}
    }));
    const snapshot: import('../recovery/types').RecoveryJournalSnapshot = {
      version: 1,
      sequence: 7,
      scope: {
        network: `${endpoints.getEffectiveNetworkName()}:${endpoints.getEffectiveRpcUrl()}`,
        walletGeneration: 'retained-wallet',
        sdkGeneration: 'retained-sdk'
      },
      accounts: [{ accountId: 'retained-account', nonce: '4', commitment: 'state-4' }],
      entries: [note]
    };
    const sink = jest.fn<
      ReturnType<import('../recovery/note-acquisition').NoteAcquisitionSink>,
      Parameters<import('../recovery/note-acquisition').NoteAcquisitionSink>
    >(async () => {});
    acquisition.installNoteAcquisitionSink(sink);
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'validate' });
    const incident = health.getStorageHealth();
    let current = true;
    let opId: string | undefined;
    let finish: (response: unknown) => void = () => {};
    fakeChrome.runtime.sendMessage.mockImplementation((message: unknown) => {
      if (typeof message !== 'object' || message === null || Reflect.get(message, 'type') !== 'OFFSCREEN_CALL')
        return Promise.resolve(undefined);
      const id: unknown = Reflect.get(message, 'op_id');
      if (typeof id === 'string') opId = id;
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const originalHold: unknown = G.__px.inlineHold;
    const running = core.withWasmClientLock(async hold => {
      G.__px.inlineHold = hold;
      try {
        await health.withStorageRecoveryAccess(incident.epoch, Date.now() + 5000, capability => {
          const command = {
            kind: 'note',
            note,
            accountId: 'retained-account'
          } satisfies import('../recovery/sdk-restore').SdkRecoveryCommand;
          if (!registered) return proxy.midenClientProxy.restoreStorageRecovery(command, capability);
          return withRetainedNoteReceipt(
            snapshot,
            note,
            command.accountId,
            capability,
            () => {
              health.assertStorageRecoveryAllowed(capability);
              core.assertWasmHoldCurrent(hold, 'offscreen receipt fixture');
              if (!current) throw new Error('Receipt owner retired');
            },
            receipt => proxy.midenClientProxy.restoreStorageRecovery(command, capability, receipt)
          );
        });
      } finally {
        G.__px.inlineHold = originalHold;
      }
    });
    const settled = running.then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      for (let index = 0; index < 20 && opId === undefined; index++) await flush();
      expect(typeof opId).toBe('string');
    } catch (error) {
      finish({ ok: false, op_id: opId });
      await settled;
      acquisition.uninstallNoteAcquisitionSink(sink);
      await health.resetStorageHealthForLifecycle(health.getStorageHealth().epoch);
      throw error;
    }
    if (!opId) throw new Error('Recovery dispatch fixture did not reach the bridge');
    const operationId = opId;
    expect(proxy.__test.inFlightOpIds()).toContain(operationId);
    proxy.markOpStarted(operationId);
    const message: Parameters<typeof proxy.handleOffscreenNoteAcquisition>[0] = {
      op_id: operationId,
      epoch: incident.epoch,
      network: endpoints.getEffectiveNetworkName(),
      notes: toSerializable([{ ...note, noteFile: canonicalBytes }])
    };
    const stop = async () => {
      finish({ ok: true, op_id: operationId, resultB64: null });
      await settled;
    };
    return {
      proxy,
      health,
      incident,
      sink,
      message,
      canonicalBytes,
      retainedBytes,
      retire: () => {
        current = false;
      },
      stop,
      restore: async () => {
        await stop();
        acquisition.uninstallNoteAcquisitionSink(sink);
        await health.resetStorageHealthForLifecycle(health.getStorageHealth().epoch);
      }
    };
  }

  it('acknowledges exact canonical retained bytes for its live recovery operation without a fresh write', async () => {
    const f = await fixture();
    try {
      expect(f.canonicalBytes).not.toEqual(f.retainedBytes);
      expect(await f.proxy.handleOffscreenNoteAcquisition(f.message)).toEqual({ ok: true, op_id: f.message.op_id });
      expect(f.sink).not.toHaveBeenCalled();
      expect(f.health.getStorageHealth()).toEqual(f.incident);
    } finally {
      await f.restore();
    }
  });

  it('refuses a second acknowledgement on the same retained receipt', async () => {
    const f = await fixture();
    try {
      expect(await f.proxy.handleOffscreenNoteAcquisition(f.message)).toEqual({ ok: true, op_id: f.message.op_id });
      expect(await f.proxy.handleOffscreenNoteAcquisition(f.message)).toEqual({ ok: false, op_id: f.message.op_id });
      expect(f.sink).not.toHaveBeenCalled();
      expect(f.health.getStorageHealth()).toEqual(f.incident);
    } finally {
      await f.restore();
    }
  });

  it.each(['missing authority', 'changed bytes', 'foreign family', 'wrong epoch', 'wrong network', 'retired owner'])(
    'refuses %s without fresh write authority or health reset',
    async change => {
      const f = await fixture({ registered: change !== 'missing authority' });
      try {
        const message = { ...f.message };
        if (change === 'changed bytes' || change === 'foreign family') {
          message.notes = [
            {
              kind: 'note',
              id: (change === 'foreign family' ? 'aa' : 'ab').repeat(32),
              detailsId: 'cd'.repeat(32),
              noteFile: change === 'changed bytes' ? [19, 48, 113] : Array.from(f.canonicalBytes),
              provenance: 'input',
              format: 'full'
            }
          ];
        }
        if (change === 'wrong epoch') message.epoch = f.incident.epoch + 1;
        if (change === 'wrong network') message.network = 'other-network';
        if (change === 'retired owner') f.retire();
        expect(await f.proxy.handleOffscreenNoteAcquisition(message)).toEqual({ ok: false, op_id: f.message.op_id });
        expect(f.sink).not.toHaveBeenCalled();
        expect(f.health.getStorageHealth()).toEqual(f.incident);
      } finally {
        await f.restore();
      }
    }
  );

  it('refuses a late acknowledgement after its operation and receipt have ended', async () => {
    const f = await fixture();
    try {
      await f.stop();
      expect(f.proxy.__test.inFlightOpIds()).not.toContain(f.message.op_id);
      expect(await f.proxy.handleOffscreenNoteAcquisition(f.message)).toEqual({ ok: false, op_id: f.message.op_id });
      expect(f.sink).not.toHaveBeenCalled();
      expect(f.health.getStorageHealth()).toEqual(f.incident);
    } finally {
      await f.restore();
    }
  });
});
it.each(['sendTransaction', 'swapTransaction', 'consumeNoteId', 'newTransaction', 'guardianPipeline'])(
  'records only the actual own started deadline method %s',
  async method => {
    jest.useFakeTimers();
    try {
      const { __test, markOpStarted } = await loadProxy(true);
      const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
      fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));
      const owner = __test.dispatchCritical(method, [{}], 20);
      const result = owner.promise.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(0);
      fireReady();
      await jest.advanceTimersByTimeAsync(0);
      markOpStarted(owner.op_id);
      await jest.advanceTimersByTimeAsync(21);
      fireReady();
      await jest.advanceTimersByTimeAsync(0);
      expect(snapshotCrashDiagnostics(await result)).toMatchObject({
        offscreenDeadlineMethod: method,
        offscreenDeadlineStage: 'not_observed'
      });
    } finally {
      jest.useRealTimers();
    }
  }
);

it('binds the last accepted stage to the eligible owner and never to collateral or settled operations', async () => {
  jest.useFakeTimers();
  try {
    const { dispatchGuardianPipeline, __test, markOpStarted, handleOffscreenStageEvent } = await loadProxy(true);
    const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
    let ownerId = '';
    fakeChrome.runtime.sendMessage.mockImplementation((env: { op_id: string; method: string }) => {
      if (env.method === 'guardianPipeline') ownerId = env.op_id;
      return new Promise(() => {});
    });
    const callback = jest.fn(async () => {});
    const owner = dispatchGuardianPipeline(
      'private-account',
      new Uint8Array([1]),
      false,
      jest.fn(async () => new Uint8Array()),
      callback
    ).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    fireReady();
    await jest.advanceTimersByTimeAsync(0);
    markOpStarted(ownerId);
    handleOffscreenStageEvent(ownerId, 'proving');
    handleOffscreenStageEvent('mismatched', 'submitting');
    handleOffscreenStageEvent(ownerId, 'private-stage' as never);
    const collateral = __test.dispatchCritical('sendTransaction', [{}], null);
    const collateralResult = collateral.promise.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    markOpStarted(collateral.op_id);
    await jest.advanceTimersByTimeAsync(__test.writeDeadlineMs() + 1);
    fireReady();
    await jest.advanceTimersByTimeAsync(0);
    const ownerError = await owner,
      otherError = await collateralResult;
    expect(ownerError).not.toBe(otherError);
    expect(otherError).toMatchObject({ facts: { started: true, deadline: { owner: 'collateral' } } });
    expect(snapshotCrashDiagnostics(ownerError)).toMatchObject({
      offscreenDeadlineMethod: 'guardianPipeline',
      offscreenDeadlineStage: 'proving'
    });
    expect(snapshotCrashDiagnostics(otherError)).not.toHaveProperty('offscreenDeadlineMethod');
    expect(snapshotCrashDiagnostics(otherError)).not.toHaveProperty('offscreenDeadlineStage');
    const { snapshotOffscreenDeadline } = await import('lib/telemetry/offscreen-deadline-diagnostics');
    expect(snapshotOffscreenDeadline(otherError)).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(2);
    handleOffscreenStageEvent(ownerId, 'submitting');
    expect(callback).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

it.each(['newTransaction', 'guardianPipeline'])(
  'does not accept injected terminal observations from a %s response',
  async method => {
    const { __test } = await loadProxy(true);
    const { snapshotCrashDiagnostics } = await import('lib/telemetry/crash-diagnostics');
    fakeChrome.runtime.sendMessage.mockImplementation(async (env: { op_id: string }) => ({
      ok: false,
      op_id: env.op_id,
      error: 'original failure',
      proofWaitAvailability: 'available',
      proposalCreateApi: 'consume_notes',
      proposalCreateFamily: 'sdk_account_read',
      guardianProvingSubstep: 'prove_local',
      offscreenDeadlineMethod: 'guardianPipeline',
      offscreenDeadlineStage: 'proving',
      queueAdmissionObservation: 'selected',
      reapStartRelation: 'before_realm_cutoff',
      errorProofWaitAvailability: 'available',
      errorProposalCreate: { proposalCreateApi: 'consume_notes', proposalCreateFamily: 'sdk_account_read' },
      errorGuardianProving: { guardianProvingSubstep: 'prove_local' },
      errorOffscreenDeadline: { offscreenDeadlineMethod: 'guardianPipeline', offscreenDeadlineStage: 'proving' }
    }));
    const pending = __test.dispatchCritical(method, [{}], null).promise.catch((error: unknown) => error);
    await flush();
    fireReady();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(snapshotCrashDiagnostics(error)).toEqual({});
  }
);
