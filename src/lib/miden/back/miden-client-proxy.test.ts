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
    Account: { deserialize: (...a: any[]) => g.__px.accountDeserialize(...a) }
  };
});

jest.mock('lib/miden/sdk/miden-client', () => {
  const g = globalThis as any;
  return { getMidenClient: (...a: any[]) => g.__px.getMidenClient(...a) };
});

// Wrap the REAL offscreen-prover (so ensureOffscreenDocument / forceClose drive
// the chrome mock for real) but make `isNonSpeculativeProveInFlight` delegate to
// a togglable flag so the §4 no-kill downgrade is testable without driving a
// real prove.
jest.mock('./offscreen-prover', () => {
  const actual = jest.requireActual('./offscreen-prover');
  return {
    ...actual,
    isNonSpeculativeProveInFlight: () => (globalThis as any).__px?.proveInFlight === true
  };
});

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
    inlineGetAccount: jest.fn(async () => ({ __inlineAccount: true })),
    // The inline (flag-off) client also exposes the slice-3 read methods so the
    // flag-off pass-through of each is assertable against a spy.
    inlineSyncState: jest.fn(async () => ({ __syncSummary: true })),
    inlineExportNote: jest.fn(async () => new Uint8Array([1, 2, 3])),
    inlineGetInputNoteDetails: jest.fn(async () => [{ __inlineDetail: true }]),
    getMidenClient: jest.fn(async () => ({
      getAccount: (...a: any[]) => G.__px.inlineGetAccount(...a),
      syncState: (...a: any[]) => G.__px.inlineSyncState(...a),
      exportNote: (...a: any[]) => G.__px.inlineExportNote(...a),
      getInputNoteDetails: (...a: any[]) => G.__px.inlineGetInputNoteDetails(...a)
    })),
    proveInFlight: false
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

  it('§4 downgrade: a real prove in flight turns a read deadline into reject-without-kill', async () => {
    const { midenClientProxy, __test } = await loadProxy(true);
    const { OperationAbortedError } = await import('./offscreen-codec');
    G.__px.proveInFlight = true; // isNonSpeculativeProveInFlight() → true
    fakeChrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

    const p = midenClientProxy.call('getAccount', ['acc'], { deadlineMs: 20 }).catch((e: Error) => e);
    await flush();
    fireReady();
    await flush();

    await wait(40); // deadline fires but a prove owns the doc
    await flush();

    const err = await p;
    expect(err).toBeInstanceOf(OperationAbortedError);
    expect((err as any).reason).toBe('deadline-no-kill');
    // The doc (and the prove) survived — no teardown.
    expect(fakeChrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(__test.inFlightSize()).toBe(0);
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
