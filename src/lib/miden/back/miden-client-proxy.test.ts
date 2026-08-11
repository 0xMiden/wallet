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
    inlineExportNote: jest.fn(async () => new Uint8Array([1, 2, 3])),
    inlineGetInputNoteDetails: jest.fn(async () => [{ __inlineDetail: true }]),
    inlineGetConsumableNoteDtos: jest.fn(async () => [{ __inlineConsumable: true }]),
    inlineConsumeNoteId: jest.fn(async () => ({ __inlineTxResult: true })),
    // A real pass-through lock so the flag-off "caller lock preserved" assertion
    // is meaningful (spy call count) while still executing the wrapped op.
    withWasmClientLock: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    getMidenClient: jest.fn(async () => ({
      getAccount: (...a: any[]) => G.__px.inlineGetAccount(...a),
      syncState: (...a: any[]) => G.__px.inlineSyncState(...a),
      exportNote: (...a: any[]) => G.__px.inlineExportNote(...a),
      getInputNoteDetails: (...a: any[]) => G.__px.inlineGetInputNoteDetails(...a),
      getConsumableNoteDtos: (...a: any[]) => G.__px.inlineGetConsumableNoteDtos(...a),
      consumeNoteId: (...a: any[]) => G.__px.inlineConsumeNoteId(...a)
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

describe('MidenClientProxy — slice-3 reads: exportNote', () => {
  it('flag OFF → exportNote goes inline and returns the raw bytes', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const bytes = await midenClientProxy.exportNote('note-1', 'Details' as any);

    expect(G.__px.inlineExportNote).toHaveBeenCalledWith('note-1', 'Details');
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

    expect(G.__px.inlineGetInputNoteDetails).toHaveBeenCalledWith({ ids: ['n1'] });
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

describe('MidenClientProxy — slice-4 consumable notes (DTO round-trip)', () => {
  it('flag OFF → getConsumableNotes goes inline via getConsumableNoteDtos (the reducing form)', async () => {
    const { midenClientProxy } = await loadProxy(false);
    const notes = await midenClientProxy.getConsumableNotes('acc-1');

    // Flag-off routes to the DTO-reducing interface method, NOT the raw
    // getConsumableNotes — so the reclaim gate + reduction run inline, exactly
    // as before this slice (just relocated into one place).
    expect(G.__px.inlineGetConsumableNoteDtos).toHaveBeenCalledWith('acc-1');
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

  it('a sendMessage transport rejection surfaces the transport error (finishOpError)', async () => {
    const { midenClientProxy } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    fakeChrome.runtime.sendMessage.mockRejectedValue(new Error('message port closed before a response'));

    const p = midenClientProxy.call('getAccount', ['a'], { deadlineMs: null }).catch((e: Error) => e);
    await flush();
    fireReady();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OperationAbortedError);
    expect((err as Error).message).toContain('message port closed');
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

  it('flag ON → dispatches a whole-op OFFSCREEN_CALL (minimal DTO, 90s deadline, criticalOp bracketed) + rehydrates', async () => {
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
    // Exactly one OFFSCREEN_CALL, method consumeNoteId, 90s deadline, MINIMAL DTO.
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

  it('locked vault mid-sign → DEFER: reason recorded (readLastAuthReason) + error tagged (isLockedError) — issue #313', async () => {
    const { midenClientProxy, handleOffscreenSignRequest } = await loadProxy(true);
    const { bytesToB64 } = await import('./offscreen-codec');
    const { takeLastSignReason } = await import('../transaction/sign-callback');
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
    // The consume error is tagged reason:'locked' so isLockedError(err) → defer.
    expect((err as any).reason).toBe('locked');
    // And the SW-side reason slot readLastAuthReason consults holds 'locked'.
    expect(takeLastSignReason()).toBe('locked');
  });
});

describe('MidenClientProxy — slice-5a §5 write kill window', () => {
  it("the write's OWN deadline fires (unresolved op = wedged execute/prove/submit/apply) → closeDocument + reject + reopen", async () => {
    const { __test } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    // The offscreen op never responds → only the write's own deadline can end it.
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const { op_id, promise } = __test.dispatchCritical('consumeNoteId', [{}], 20);
    const p = promise.catch((e: Error) => e);
    await flush();
    fireReady(); // open resolves → message sent → deadline armed
    await flush();
    expect(__test.inFlightSize()).toBe(1);
    expect(op_id).toBeTruthy();

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
    const { handleOffscreenSignRequest, __test } = await loadProxy(true);
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
