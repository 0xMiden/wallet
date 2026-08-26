/**
 * Guardian write LEAF PIPELINE → offscreen routing (issue #260, slices 6a + 6b + 7c).
 *
 * These tests exercise `generateTransaction` at the routing seam: with the
 * offscreen client flag OFF the routable guardian leaf runs inline
 * (`runGuardianPipeline` → the mocked SW client's execute→prove→submit→apply);
 * with it ON the SAME leaf crosses to `dispatchGuardianPipeline`. Everything
 * around the leaf — proposal creation, cold co-sign, mid-flight `persistNewHotKey`,
 * `signAndCreateTransactionRequest`, and the `abandonCandidate` submit-catch — stays
 * SW-side and is asserted unchanged. The structural `waitForTransactionCommit` now
 * routes through `midenClientProxy.waitForTransactionCommit` (issue #260, slice 6b
 * bug fix) so it polls the SAME client that applied the tx — the offscreen realm
 * flag-on, the SW client flag-off — instead of always poking the raw SW client
 * (which flag-on is dormant, timing the wait out and stranding the completion).
 *
 * Slice 6a covers the four VALUE-MOVING types (send / consume / swap / execute);
 * slice 6b adds the three STRUCTURAL types (switch-guardian / replace-hot-key /
 * update-procedure-threshold), which additionally exercise: the cold co-sign +
 * `persistNewHotKey` running SW-side BEFORE dispatch (byte-identical order flag-on
 * vs flag-off), the proxy-routed `waitForTransactionCommit` running AFTER with the
 * re-derived tx id, and the structural apply-after-submit classifier (reconcile for
 * replace-hot-key / switch-guardian; Fail for update-procedure-threshold).
 *
 * Coverage:
 *   - §4.0 round-trip: the co-signed request crosses to the offscreen leaf as the
 *     EXACT `tr.serialize()` bytes (advice map — carrying the co-signatures —
 *     intact; the byte-level serialize→transport→deserialize→execute round-trip is
 *     proven in miden-client-proxy.test.ts + offscreen/main.test.ts).
 *   - flag routing OFF/ON per value-moving AND structural type; slice 7c adds the last
 *     two value-moving types (bridged-send / earn-deposit), which now route offscreen
 *     like send/swap — with the errorCode classifier marking them Failed (not Completed)
 *     on a post-submit apply failure, byte-identical to their flag-OFF inline throw.
 *   - flag-off/flag-on byte-identity: the completion handler receives a result with
 *     identical `serialize()` bytes on both paths.
 *   - persistNewHotKey ordering parity: replace-hot-key persists the new hot key
 *     SW-side, exactly once, with identical args and BEFORE the leaf, on both flags.
 *   - waitForTransactionCommit: for structural types it routes through the proxy
 *     AFTER the leaf with the id re-derived from `result.executedTransaction().id()`,
 *     on both flags — never the raw SW `getMidenClient().waitForTransactionCommit`.
 *   - kill-window (funds-safety): an offscreen `OperationAbortedError` (wedge-kill)
 *     runs `abandonCandidate` exactly once (as inline) and marks the row FAILED —
 *     it is NOT auto-requeued, and it dispatches exactly ONCE. A guardian
 *     send/swap/execute has NO input-note nullifier (each retry builds a FRESH
 *     proposal with a new random output-note serial), so auto-requeueing would let
 *     the retry build a second valid send and DOUBLE-SEND; a structural op is
 *     nonce-gated and excluded from REQUEUEABLE_TYPES (never auto-requeued), so its
 *     only recovery is a user re-run against post-change chain state — never a
 *     double-apply. Falling through to Failed matches slices 5a/5b and flag-OFF.
 *   - errorCode: a round-tripped `ApplyTransactionAfterSubmitFailed` reaches the
 *     GUARDIAN classifier → value-moving marks Completed (mirrors the fixed
 *     non-guardian bug); structural replace-hot-key / switch-guardian route to the
 *     reconcile handler, update-procedure-threshold to Failed.
 */

import { generateTransaction } from './index';
import { OperationAbortedError } from '../back/offscreen-codec';
import { ITransactionStatus } from '../db/types';

// The distinctive co-signed-request bytes the mock `signAndCreateTransactionRequest`
// emits. The flag-ON route MUST forward these bytes verbatim to the offscreen leaf
// — that is the §4.0 precondition (Rust `Serializable for TransactionRequest` writes
// `advice_map.write_into(target)`, so the extended advice map holding the hot/cold/
// guardian co-signatures survives serialize; verified end-to-end at the WASM level in
// the flag-flip guardian E2E, structurally here).
const TR_BYTES = [0xc0, 0x51, 0x67, 0xed];

const txStore: Array<Record<string, unknown>> = [];

// When set, the row write that LEAVES the row at this stage rejects — the Dexie
// hiccup a stage stamp must survive. Only the stamp for that one stage throws
// (nothing else in a run sets `stage` to a leaf stage), so it isolates the stamp
// from the surrounding status writes. Null (the default, restored in beforeEach)
// leaves every write untouched.
// eslint-disable-next-line no-var
var mockThrowOnStageWrite: string | null = null;
// Makes the row read inside the requeue wake fail a bounded number of times, so
// the wake's read-failure path is reachable. Armed AFTER the requeue, since the
// requeue itself reads the row through the same seam.
var mockFailRowReads: { id: string; times: number } | null = null;

// One-shot: the next read of this row returns the row as it was, then advances
// the stored row to GeneratingTransaction, as a concurrent driver picking it up
// would. Lets a test occupy the gap between a read and its write.
var mockClaimRowOnRead: { id: string } | null = null;

// How many `modify` callbacks returned `false`. Dexie skips the put on exactly
// that value and treats anything else — `undefined` included — as "modified",
// re-putting the clone and firing a `liveQuery` event for it. A guard written as
// a bare `return` therefore still writes, and without counting the declines no
// assertion can tell the two apart: the clone equals the row, so the stored
// fields look identical either way.
var mockDeclinedWrites = 0;

// Dexie's `innerDeepClone`: recurse into plain objects, hand everything else
// back by reference.
function dexieLikeClone<T>(value: T): T {
  if (value === null || typeof value !== 'object' || value.constructor !== Object) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) copy[key] = dexieLikeClone(nested);
  return copy as T;
}

jest.mock('lib/miden/repo', () => ({
  db: { transaction: async (_mode: string, _t: unknown, cb: () => unknown) => cb() },
  transactions: {
    add: jest.fn(async (tx: Record<string, unknown>) => {
      txStore.push({ ...tx });
    }),
    where: jest.fn((query: { id: string }) => ({
      modify: jest.fn(async (fn: (tx: Record<string, unknown>) => unknown) => {
        const row = txStore.find(r => r.id === query.id);
        // Dexie hands the callback a CLONE and only writes it back when the
        // callback does not return `false` — which is the entire mechanism
        // behind the write-time terminal guards. Mutating the stored row
        // directly would make those guards untestable: move one below its first
        // assignment and the suite would stay green while production wrote over
        // a terminal row.
        if (row) {
          // Deep over PLAIN objects only, which is what Dexie's own clone does:
          // it recurses into plain objects and returns anything with a
          // non-`Object` constructor — typed arrays, class instances — by
          // reference. A shallow copy would share `stageTimestamps` and
          // `extraInputs` with the stored row, so a callback that mutated a
          // nested field and then declined would still have written through,
          // which is the one case this mock exists to catch. `structuredClone`
          // is not a substitute: it throws on the functions and class instances
          // these fixtures carry.
          const draft = dexieLikeClone(row);
          if (fn(draft) === false) mockDeclinedWrites += 1;
          else Object.assign(row, draft);
        }
        if (mockThrowOnStageWrite !== null && row?.stage === mockThrowOnStageWrite) {
          throw new Error(`dexie write blew up stamping '${mockThrowOnStageWrite}'`);
        }
      }),
      first: jest.fn(async () => {
        if (mockFailRowReads !== null && mockFailRowReads.id === query.id && mockFailRowReads.times > 0) {
          mockFailRowReads.times -= 1;
          throw new Error('dexie read blew up');
        }
        const found = txStore.find(r => r.id === query.id);
        // Model a concurrent driver claiming the row in the gap between a
        // caller's read and its write: hand back the stale snapshot the caller
        // would have seen, and advance the stored row as the driver would.
        if (found && mockClaimRowOnRead !== null && mockClaimRowOnRead.id === query.id) {
          mockClaimRowOnRead = null;
          const snapshot = { ...found };
          found.status = ITransactionStatus.GeneratingTransaction;
          return snapshot;
        }
        return found;
      })
    })),
    filter: jest.fn(() => ({ toArray: jest.fn(async () => []) }))
  }
}));

// `generateTransactionsLoop` reaches the table through `filter`, so its call
// count is the only observable this suite has for "the queue was actually
// driven" — which is what a wake exists to do, and what a timer merely firing
// does not prove.
const repoMock = jest.requireMock('lib/miden/repo') as { transactions: { filter: jest.Mock } };

/**
 * jsdom has no `navigator.locks`, so `safeGenerateTransactionsLoop` throws into
 * its own catch and returns false without ever touching the table — which would
 * make "the wake drove the queue" unobservable and the assertion vacuous.
 * Granting the lock lets the loop run for real.
 */
const installNavigatorLocks = (): (() => void) => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = 'locks' in nav;
  const prev = nav.locks;
  Object.defineProperty(nav, 'locks', {
    value: { request: (_n: string, _o: unknown, cb: (lock: object) => unknown) => cb({}) },
    writable: true,
    configurable: true
  });
  return () => {
    if (had) Object.defineProperty(nav, 'locks', { value: prev, writable: true, configurable: true });
    else delete nav.locks;
  };
};

jest.mock('../front', () => ({
  putToStorage: jest.fn(async () => {}),
  fetchFromStorage: jest.fn(),
  onStorageChanged: jest.fn()
}));

jest.mock('lib/settings/constants', () => ({ GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting' }));

const mockIsGuardianAccount = jest.fn();
const mockGetOrCreateMultisigService = jest.fn();
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: (...a: unknown[]) => mockIsGuardianAccount(...a),
  getOrCreateMultisigService: (...a: unknown[]) => mockGetOrCreateMultisigService(...a),
  clearGuardianServiceFor: jest.fn()
}));

// Cold-service factory (structural ops: switch-guardian cold co-sign, and the
// cold-bound service that replace-hot-key / update-procedure-threshold create
// their proposal + final `signAndCreateTransactionRequest` on). Controllable so a
// structural test can inspect the co-signed-request bytes and abandon/complete
// call order.
const mockBuildColdMultisigService = jest.fn();
jest.mock('lib/miden/guardian', () => ({
  MultisigService: { buildColdMultisigService: (...a: unknown[]) => mockBuildColdMultisigService(...a) }
}));

const mockWithWasmClientLock = jest.fn(async (fn: () => Promise<unknown>) => fn());
const mockGetMidenClient = jest.fn();
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: (...a: unknown[]) => mockWithWasmClientLock(...(a as [() => Promise<unknown>])),
  withWasmLockWatchdogPaused: async <T>(fn: () => Promise<T>) => fn(),
  getMidenClient: (...a: unknown[]) => mockGetMidenClient(...a)
}));

// The routing seam under test: `dispatchGuardianPipeline` is a controllable spy,
// and `midenClientProxy.syncState` is the pre-guardian sync (no-op here).
const mockDispatchGuardianPipeline = jest.fn();
// The SW-side local-client `getAccount` (structural ops resolve the SDK account
// here to build a cold service / mint the replacement hot key). Value-moving
// types never call it, so the default `null` is harmless for them.
const mockProxyGetAccount = jest.fn(async (..._a: unknown[]) => null as unknown);
// The post-pipeline commit-wait now routes through the PROXY (issue #260, slice 6b
// bug fix), not the raw SW client. Mocking it here lets the call-site tests assert
// the structural path polls the proxy (which internally picks the offscreen realm
// flag-on / the SW client flag-off — proven in miden-client-proxy.test.ts) and NOT
// the dormant SW `getMidenClient().waitForTransactionCommit` directly.
const mockProxyWaitForCommit = jest.fn(async (..._a: unknown[]) => {});
// The node-authoritative input-note read used by `verifyConsumeLanded` (#260
// follow-up #3a) when a killed CONSUME must be checked for landing on chain.
// Default: note not found → 'unknown' → the killed consume falls through to Failed
// (the pre-#3a behavior for the non-consume kill tests that don't touch it).
const mockProxyGetInputNoteDetails = jest.fn(async (..._a: unknown[]) => [] as unknown[]);
jest.mock('../back/miden-client-proxy', () => ({
  dispatchGuardianPipeline: (...a: unknown[]) => mockDispatchGuardianPipeline(...a),
  midenClientProxy: {
    syncState: jest.fn(async () => {}),
    getAccount: (...a: unknown[]) => mockProxyGetAccount(...a),
    waitForTransactionCommit: (...a: unknown[]) => mockProxyWaitForCommit(...a),
    getInputNoteDetails: (...a: unknown[]) => mockProxyGetInputNoteDetails(...a)
  }
}));

// Offscreen API present, so the FLAG alone decides the route.
jest.mock('../back/offscreen-prover', () => ({ isOffscreenAvailable: () => true }));

// Completion handlers as spies so byte-identity (what result they receive) and
// "value already moved → completion NOT re-run" are directly assertable.
const mockComplete = {
  send: jest.fn(async (..._a: unknown[]) => {}),
  consume: jest.fn(async (..._a: unknown[]) => {}),
  swap: jest.fn(async (..._a: unknown[]) => {}),
  custom: jest.fn(async (..._a: unknown[]) => {}),
  bridged: jest.fn(async (..._a: unknown[]) => {}),
  earn: jest.fn(async (..._a: unknown[]) => {}),
  switchGuardian: jest.fn(async (..._a: unknown[]) => {}),
  replaceHotKey: jest.fn(async (..._a: unknown[]) => {}),
  updateThreshold: jest.fn(async (..._a: unknown[]) => {})
};
jest.mock('./complete', () => ({
  completeSendTransaction: (...a: unknown[]) => mockComplete.send(...a),
  completeConsumeTransaction: (...a: unknown[]) => mockComplete.consume(...a),
  completeSwapTransaction: (...a: unknown[]) => mockComplete.swap(...a),
  completeCustomTransaction: (...a: unknown[]) => mockComplete.custom(...a),
  completeBridgedSendTransaction: (...a: unknown[]) => mockComplete.bridged(...a),
  completeEarnDepositTransaction: (...a: unknown[]) => mockComplete.earn(...a),
  completeSwitchGuardianTransaction: (...a: unknown[]) => mockComplete.switchGuardian(...a),
  completeReplaceHotKeyTransaction: (...a: unknown[]) => mockComplete.replaceHotKey(...a),
  completeUpdateProcedureThresholdTransaction: (...a: unknown[]) => mockComplete.updateThreshold(...a)
}));

const mockCreateWasmWebClient = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    TransactionProver: {
      newLocalProver: jest.fn(() => 'local-prover'),
      newCallbackProver: jest.fn(() => 'callback-prover')
    },
    WasmWebClient: { createClient: (endpoint: string) => mockCreateWasmWebClient(endpoint) }
  };
});

jest.mock('../sdk/native-prover-mobile', () => ({
  buildNativeProverCallback: jest.fn(() => async () => new Uint8Array())
}));

// eslint-disable-next-line no-var
var mockPlatformIsMobile = false;
// jsdom carries a mocked `chrome.runtime.id`, so the real `isExtension()` is
// TRUE in every unit test. Anything gated on being off-extension is therefore
// unreachable — and silently so — unless the test can drive this.
// eslint-disable-next-line no-var
var mockPlatformIsExtension = true;
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => mockPlatformIsMobile,
  isExtension: () => mockPlatformIsExtension
}));

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn(), info: jest.fn() }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  canonicalWalletAccountId: (id: string) => id.split('_')[0] ?? id,
  sameWalletAccountId: (a: string, b: string) => (a.split('_')[0] ?? a) === (b.split('_')[0] ?? b)
}));

jest.mock('lib/intercom', () => ({ getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() }) }));
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));

// A TransactionResult-like whose serialize() and executedTransaction().id() are
// stable, so byte-identity + id re-derivation are assertable across flag paths.
const makeResult = (bytes: number[] = [9, 9, 9]) => ({
  executedTransaction: () => ({
    id: () => ({ toHex: () => 'exec-tx-hash' }),
    outputNotes: () => ({ notes: () => [] }),
    inputNotes: () => ({ notes: () => [] })
  }),
  serialize: () => new Uint8Array(bytes)
});

// The inline (flag-off) SW client leaf: execute→prove→submit→apply, returning the
// TransactionExecution whose `.result` runGuardianPipeline hands back.
const makeInlineClient = (result: ReturnType<typeof makeResult>) => {
  const executeRequest = jest.fn(async () => ({
    id: result.executedTransaction().id(),
    result,
    prove: async () => ({
      submit: async () => ({ result, apply: jest.fn(async () => {}) })
    })
  }));
  return {
    syncState: jest.fn(async () => {}),
    getAccount: jest.fn(async () => null),
    waitForTransactionCommit: jest.fn(async () => {}),
    client: { transactions: { executeRequest } },
    __executeRequest: executeRequest
  };
};

const makeService = () => ({
  createSendProposal: jest.fn(async () => ({ id: 'prop', nonce: 7 })),
  createConsumeNotesProposal: jest.fn(async () => ({ id: 'prop', nonce: 7 })),
  createCustomProposal: jest.fn(async () => ({ id: 'prop', nonce: 7 })),
  signAndCreateTransactionRequest: jest.fn(async () => ({
    serialize: () => new Uint8Array(TR_BYTES),
    authArg: () => undefined
  })),
  abandonCandidate: jest.fn(async () => {}),
  sync: jest.fn(async () => {})
});

const provider = {
  getAccounts: async () => [] as unknown[],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig'
};

// A value-moving fixture per type: the DB row + the completion spy that finalizes it.
type Case = { type: string; row: Record<string, unknown>; complete: jest.Mock };
const valueMovingCases = (): Case[] => [
  {
    type: 'send',
    row: { type: 'send', secondaryAccountId: 'recipient', faucetId: 'faucet', amount: '1000' },
    complete: mockComplete.send
  },
  {
    type: 'consume',
    row: { type: 'consume', noteId: '0xn1', noteIds: ['0xn1'] },
    complete: mockComplete.consume
  },
  {
    type: 'swap',
    row: {
      type: 'swap',
      faucetId: 'faucet',
      amount: '5',
      requestBytes: new Uint8Array([1, 1]),
      extraInputs: { requestedFaucetId: 'rfaucet', requestedAmount: '10' }
    },
    complete: mockComplete.swap
  },
  {
    type: 'execute',
    row: { type: 'execute', requestBytes: new Uint8Array([2, 2]) },
    complete: mockComplete.custom
  }
];

// Slice 7c: the last two value-moving guardian types. Both are hot-bound
// custom-proposal sends that cross the SAME leaf as send/swap — bridged-send
// (agglayer) previews its pre-built request into a custom proposal; earn-deposit
// carries a pre-seeded `requestBytes` so `ensureGuardianRecallableSendRequestBytes`
// short-circuits (no WasmWebClient / getSyncHeight) and routes through the SAME
// custom proposal. They match the value-moving cases on routing / byte-identity /
// kill-window; they DIVERGE only on the errorCode classifier (→ Failed, not
// Completed — see the dedicated block below), so they are their own case list.
const bridgeEarnCases = (): Case[] => [
  {
    type: 'bridged-send',
    row: {
      type: 'bridged-send',
      secondaryAccountId: 'r',
      faucetId: 'f',
      amount: '3',
      requestBytes: new Uint8Array([3, 3]),
      extraInputs: { provider: 'agglayer' }
    },
    complete: mockComplete.bridged
  },
  {
    type: 'earn-deposit',
    row: {
      type: 'earn-deposit',
      secondaryAccountId: 'r',
      faucetId: 'f',
      amount: '5',
      requestBytes: new Uint8Array([4, 4]),
      extraInputs: { recallBlocks: 10 }
    },
    complete: mockComplete.earn
  }
];

const buildTx = (id: string, extra: Record<string, unknown>) => ({
  id,
  accountId: 'guardian-acc',
  status: ITransactionStatus.Queued,
  displayMessage: 'Queued',
  displayIcon: 'DEFAULT',
  delegateTransaction: false,
  initiatedAt: Math.floor(Date.now() / 1000),
  ...extra
});

const signCallback = jest.fn(async () => new Uint8Array([2]));

/** Arrange a full value-moving guardian run: seed the row, service, inline client. */
function arrange(id: string, extra: Record<string, unknown>, result = makeResult()) {
  const row = buildTx(id, extra);
  txStore.push({ ...row });
  const service = makeService();
  mockGetOrCreateMultisigService.mockResolvedValue(service);
  const inline = makeInlineClient(result);
  mockGetMidenClient.mockResolvedValue(inline);
  mockIsGuardianAccount.mockResolvedValue(true);
  return { row, service, inline };
}

beforeEach(() => {
  jest.clearAllMocks();
  txStore.length = 0;
  mockPlatformIsMobile = false;
  // Reset alongside its siblings. Left `false` by a test that forgot to restore
  // it, every LATER unauthorized requeue in this file arms a real 16-56s timer
  // (the suite runs on real timers), which then fires after the run has moved on.
  mockPlatformIsExtension = true;
  mockThrowOnStageWrite = null;
  mockFailRowReads = null;
  mockClaimRowOnRead = null;
  mockDeclinedWrites = 0;
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

afterEach(() => {
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

describe('guardian leaf routing — flag OFF (inline)', () => {
  it.each(valueMovingCases())(
    '$type: runs the inline pipeline, never dispatchGuardianPipeline',
    async ({ row, complete }) => {
      const { service, inline } = arrange(`off-${row.type}`, row);

      await generateTransaction(buildTx(`off-${row.type}`, row) as never, signCallback, false, provider as never);

      // Inline leaf ran; offscreen was never touched.
      expect(inline.__executeRequest).toHaveBeenCalledTimes(1);
      expect(mockDispatchGuardianPipeline).not.toHaveBeenCalled();
      // The completion handler finalized with the inline result; abandon never ran.
      expect(complete).toHaveBeenCalledTimes(1);
      expect(service.abandonCandidate).not.toHaveBeenCalled();
    }
  );
});

describe('guardian leaf routing — flag ON (offscreen)', () => {
  it.each(valueMovingCases())(
    '$type: crosses the co-signed request bytes to dispatchGuardianPipeline, never runs the inline leaf',
    async ({ row, complete }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      const dispatched = makeResult();
      mockDispatchGuardianPipeline.mockResolvedValue(dispatched);
      const { inline } = arrange(`on-${row.type}`, row);

      await generateTransaction(buildTx(`on-${row.type}`, row) as never, signCallback, false, provider as never);

      // The inline SW leaf never executed; the offscreen leaf did.
      expect(inline.__executeRequest).not.toHaveBeenCalled();
      expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
      const [acct, trBytes, delegate, cb] = mockDispatchGuardianPipeline.mock.calls[0];
      expect(acct).toBe('guardian-acc');
      // §4.0: the co-signed request crossed as the EXACT serialized bytes.
      expect(Array.from(trBytes as Uint8Array)).toEqual(TR_BYTES);
      expect(delegate).toBe(false);
      expect(cb).toBe(signCallback);
      // Same completion handler finalized with the round-tripped result.
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]).toContain(dispatched);
    }
  );

  it('an "unauthorized" execution failure requeues even though the realm cannot author `stage`', async () => {
    // The guardian co-signs a summary bound to the state it saw; if that state
    // moves before the leaf's executeRequest recomputes it, execution rejects
    // the signature. `guardianPipeline` throws from executeRequest, which sits
    // before its own postStageEvent('submitting') and provenTx.submit(), so
    // nothing reached the chain and the transfer is recoverable.
    //
    // The requeue must NOT be gated on the row's `stage`: an offscreen leaf's
    // stamps are replayed as `timingOnly` precisely so they never author that
    // field, so the row still reads whichever stage the SW stamped last. Gating
    // on 'executing' would make the whole arm dead code on the shipping path —
    // the service-worker bundle defaults MIDEN_USE_OFFSCREEN_CLIENT to 'true'.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
          'transaction execution failed: transaction is unauthorized with summary ' +
          'TransactionSummary { nonce_delta: 1 }'
      )
    );
    const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    arrange('on-send-unauthorized', row);
    const before = Math.floor(Date.now() / 1000);

    await generateTransaction(buildTx('on-send-unauthorized', row) as never, signCallback, false, provider as never);

    const stored = txStore.find(r => r.id === 'on-send-unauthorized') as Record<string, unknown>;
    // The leaf was actually reached — without this the test would pass for any
    // earlier crash, e.g. a renamed mock silently short-circuiting the pipeline.
    expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
    // Guards the point of the test: if the realm ever DID author `stage`, a
    // stage-gated implementation would pass here for the wrong reason.
    expect(stored.stage).not.toBe('executing');
    expect(stored.status).toBe(ITransactionStatus.Queued);
    expect(stored.processingStartedAt).toBeUndefined();
    // Bounded on BOTH sides: a bare "is a number" assertion stays green if the
    // cooldown is changed to 0 (the row is re-picked every ~5s poll, hammering
    // the guardian and starving other accounts) or to something so large the row
    // never becomes eligible again before MAX_QUEUED_AGE reaps it. The jitter is
    // pinned below rather than left to the draw, which only caught a zeroed base
    // cooldown about three runs in four.
    expect(Number(stored.nextEligibleAt)).toBeGreaterThanOrEqual(before + 15);
    expect(Number(stored.nextEligibleAt)).toBeLessThanOrEqual(before + 54);
  });

  it('the stamped cooldown lands inside the jittered 15-54s window', async () => {
    // The BOUNDS are pinned here; the boundary VALUES are pinned directly on
    // `unauthorizedRequeueCooldownSec` in transactions.cooldown.test.ts. Split
    // that way deliberately: pinning the exact value here needs a constant
    // `Math.random`, and a constant draw held across a failing assertion makes
    // jest's source-map sort degenerate, so the run reports
    // `RangeError: Maximum call stack size exceeded` instead of the expectation
    // that failed. This test therefore mocks no clock and no draw, and asserts
    // the property that matters end to end: whatever the draw, the row is
    // re-eligible inside the documented window.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
          'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
      )
    );
    const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    arrange('on-send-unauthorized-jitter', row);
    const before = Math.floor(Date.now() / 1000);

    await generateTransaction(
      buildTx('on-send-unauthorized-jitter', row) as never,
      signCallback,
      false,
      provider as never
    );

    const stored = txStore.find(r => r.id === 'on-send-unauthorized-jitter') as Record<string, unknown>;
    expect(stored.status).toBe(ITransactionStatus.Queued);
    expect(Number(stored.nextEligibleAt)).toBeGreaterThanOrEqual(before + 15);
    expect(Number(stored.nextEligibleAt)).toBeLessThanOrEqual(before + 54);
  });

  it('an unauthorized consume requeues too — the same race hit claims in the field', async () => {
    // The stress run that motivated this arm produced 20 failed consumes
    // alongside the 47 failed sends, with the identical error. `consume` reaches
    // the arm through the same set as `send`, and only `send` was covered.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
          'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
      )
    );
    const row = { type: 'consume', noteId: 'note-unauth' };
    arrange('on-consume-unauthorized', row);
    const before = Math.floor(Date.now() / 1000);

    await generateTransaction(buildTx('on-consume-unauthorized', row) as never, signCallback, false, provider as never);

    const stored = txStore.find(r => r.id === 'on-consume-unauthorized') as Record<string, unknown>;
    expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
    expect(stored.status).toBe(ITransactionStatus.Queued);
    // Bounded like the send case rather than merely "is a number", which stays
    // green at a cooldown of 0 — the row re-picked every poll, hammering the
    // guardian this arm is trying to give room to recover.
    expect(Number(stored.nextEligibleAt)).toBeGreaterThanOrEqual(before + 15);
    expect(Number(stored.nextEligibleAt)).toBeLessThanOrEqual(before + 54);
  });

  it('an unauthorized replace-hot-key is NOT requeued — a structural op must not re-mint', async () => {
    // The type gate is the only thing stopping a structural op from re-running a
    // proposal creator that has already minted a hardware hot key, orphaning one
    // per cycle. Without this test the whole `UNAUTHORIZED_EXECUTION_REQUEUEABLE`
    // conjunct is mutation-dead: deleting it leaves every suite green.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
          'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
      )
    );
    const row = { type: 'replace-hot-key', extraInputs: {} };
    arrange('on-replace-hot-key-unauthorized', row);

    await generateTransaction(
      buildTx('on-replace-hot-key-unauthorized', row) as never,
      signCallback,
      false,
      provider as never
    );

    const stored = txStore.find(r => r.id === 'on-replace-hot-key-unauthorized') as Record<string, unknown>;
    // Pins WHY it failed. Without this the test is vacuous: a structural op does
    // not reach the leaf in this harness, so it ends Failed for an unrelated
    // reason and the assertion below stays green even with the type gate deleted.
    // The `earn-deposit` case above and the membership test below are what
    // actually hold that gate honest.
    expect(mockDispatchGuardianPipeline).not.toHaveBeenCalled();
    expect(stored.status).toBe(ITransactionStatus.Failed);
    expect(stored.nextEligibleAt).toBeUndefined();
  });

  it('the unauthorized requeue set is exactly the value-moving retryable types', async () => {
    // Membership asserted directly because the behavioural tests cannot reach it
    // from both sides: a structural row dies before the leaf in this harness, so
    // ADDING `replace-hot-key` here changes no test's outcome, and no suite sends
    // an unauthorized `swap` or `execute`, so DROPPING those changes nothing
    // either. Both directions matter — one lets a retry re-mint a hot key, the
    // other silently narrows the fix back to the two types that happen to have
    // tests.
    const { UNAUTHORIZED_EXECUTION_REQUEUEABLE } = await import('./index');
    expect([...UNAUTHORIZED_EXECUTION_REQUEUEABLE].sort()).toEqual(['consume', 'execute', 'send', 'swap']);
  });

  it('an "unauthorized" that is NOT execution-scoped stays terminally Failed (no double-send)', async () => {
    // The requeue arm above concludes "never reached the chain" from the error
    // text alone, so that text has to pin the failure to the execute step. A
    // rejection carrying the same word from anywhere AFTER submit describes a
    // transfer that may already have landed, and requeueing it would rebuild
    // and co-sign a second valid send — the account debited twice, with no
    // input-note nullifier for the chain to reject the duplicate on.
    //
    // Without this, `isGuardianUnauthorizedExecutionError` could be reduced to
    // a bare /unauthorized/ match and every suite would stay green.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error("Offscreen call 'guardianPipeline' failed: submit rejected by node: transaction is unauthorized")
    );
    const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    arrange('on-send-unauthorized-post-submit', row);

    await generateTransaction(
      buildTx('on-send-unauthorized-post-submit', row) as never,
      signCallback,
      false,
      provider as never
    );

    const stored = txStore.find(r => r.id === 'on-send-unauthorized-post-submit') as Record<string, unknown>;
    expect(stored.status).toBe(ITransactionStatus.Failed);
    expect(stored.nextEligibleAt).toBeUndefined();
  });

  it('off-extension, an unauthorized requeue arms a wake to drive the row', async () => {
    // Off-extension there is no service worker polling the queue: the only driver
    // is the generating-transaction screen's interval, which the user cancels by
    // leaving the screen. Without this wake the requeued row sits Queued until
    // the next app launch — a send that silently does nothing, worse than the
    // failure the requeue replaced. Gated on `isExtension()`, which is TRUE for
    // every other test in this file, so without the override below the whole
    // wake is unreachable and deleting it would leave the suite green.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    const restoreLocks = installNavigatorLocks();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake', row) as never,
        signCallback,
        false,
        provider as never
      );

      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake')?.status).toBe(ITransactionStatus.Queued);
      // Scheduled past the cooldown rather than immediately — firing before
      // `nextEligibleAt` would just put the loop straight back to sleep.
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      const loopRuns = () => repoMock.transactions.filter.mock.calls.length;
      const runsBefore = loopRuns();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(loopRuns()).toBe(runsBefore);

      // Past the longest cooldown the jitter can draw: the wake fires and
      // actually DRIVES the queue. Without this the whole callback body could be
      // deleted and the suite would stay green.
      await jest.advanceTimersByTimeAsync(56_000);
      expect(loopRuns()).toBeGreaterThan(runsBefore);

      // Firing is not progress. The loop takes its lock with `ifAvailable` and
      // services the oldest eligible row, so a wake can land and leave this row
      // exactly where it was — which is the state the wake exists to prevent. It
      // re-arms while the row is still Queued.
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      const runsAfterFirst = loopRuns();
      await jest.advanceTimersByTimeAsync(4_000);
      expect(loopRuns()).toBeGreaterThan(runsAfterFirst);
    } finally {
      restoreLocks();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('comes back after a row read that fails, instead of abandoning the row', async () => {
    // The wake decides whether to re-arm by reading its own row. That read is
    // the only thing standing between the row and being stranded, so a Dexie
    // hiccup there must not end the chain — off-extension nothing else would
    // come back for it.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    const restoreLocks = installNavigatorLocks();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-readfail', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-readfail', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Armed only now: the requeue itself reads the row through this same seam.
      mockFailRowReads = { id: 'on-send-unauthorized-wake-readfail', times: 1 };
      const loopRuns = () => repoMock.transactions.filter.mock.calls.length;

      // Past the longest cooldown: the wake fires, drives the queue, and its row
      // read throws.
      await jest.advanceTimersByTimeAsync(56_000);
      // The read really did fail. Without this the test would pass on the
      // ordinary still-Queued re-arm — which produces the same timer count and
      // the same loop drive — and would never touch the catch it exists for.
      expect(mockFailRowReads?.times).toBe(0);
      const runsAfterFailedRead = loopRuns();
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      // It came back, and the next lap drives the queue again.
      await jest.advanceTimersByTimeAsync(4_000);
      expect(loopRuns()).toBeGreaterThan(runsAfterFailedRead);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    } finally {
      restoreLocks();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('keeps at most one wake per row, so repeated requeues cannot compound chains', async () => {
    // `scheduleRequeueWake` is called afresh on every unauthorized requeue, and
    // in production the second one lands while the first callback is still
    // awaiting its loop drive — before that callback reaches its own re-arm.
    // Without the per-row cancel both chains survive and each drives the loop
    // independently, multiplying queue-driver load on a row whose whole problem
    // is a guardian already under load.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-dedupe', row);
      const tx = buildTx('on-send-unauthorized-wake-dedupe', row) as never;

      await generateTransaction(tx, signCallback, false, provider as never);
      expect(jest.getTimerCount()).toBe(1);

      // A second unauthorized failure on the SAME row arms a second wake.
      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-dedupe') as Record<string, unknown>;
      stored.status = ITransactionStatus.Queued;
      await generateTransaction(tx, signCallback, false, provider as never);

      expect(jest.getTimerCount()).toBe(1);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('stops re-arming the wake once the row leaves Queued', async () => {
    // The re-arm chain has to end on its own. A row the user cancelled, or one a
    // later cycle completed, must not keep a timer alive behind it.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-stop', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-stop', row) as never,
        signCallback,
        false,
        provider as never
      );
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-stop') as Record<string, unknown>;
      stored.status = ITransactionStatus.Completed;
      await jest.advanceTimersByTimeAsync(60_000);

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('keeps watching a row another driver picked up, and drives it again if that attempt requeues', async () => {
    // `GeneratingTransaction` is not an ending. The attempt that claimed the row
    // can finish by requeueing rather than completing — through the 409, 429,
    // prover-outage or locked-wallet arms, none of which schedules a wake, since
    // only the unauthorized arm does. A chain that stopped on any non-Queued
    // status would hand the row back to a queue with no driver off-extension,
    // which is the strand it exists to prevent, and the row would look healthy
    // on the way there.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    // Needed for the DRIVE half: without a lock implementation
    // `safeGenerateTransactionsLoop` returns before touching the queue, so the
    // chain would stay armed while driving nothing and the assertion below could
    // not tell the difference.
    const restoreLocks = installNavigatorLocks();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-inflight', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-inflight', row) as never,
        signCallback,
        false,
        provider as never
      );
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-inflight') as Record<string, unknown>;
      stored.status = ITransactionStatus.GeneratingTransaction;
      await jest.advanceTimersByTimeAsync(60_000);

      // Still armed. Watching, not abandoning.
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      // That attempt requeues for an unrelated reason and schedules no wake of
      // its own. The chain that stayed alive is what drives it.
      stored.status = ITransactionStatus.Queued;
      const loopRuns = () => repoMock.transactions.filter.mock.calls.length;
      const runsBefore = loopRuns();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(loopRuns()).toBeGreaterThan(runsBefore);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    } finally {
      restoreLocks();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('keeps waking a row for longer than its whole retry budget', async () => {
    // The wake has to outlast what it is covering. An earlier version stopped
    // after 20 re-arms of 3s — about a minute against a three-minute budget — so
    // a row whose wakes kept losing the loop lock ran out of liveness while it
    // was still perfectly retryable, and sat Queued until the next app launch.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    const restoreLocks = installNavigatorLocks();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-budget', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-budget', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Past the full 180s retry budget, with the row never picked up.
      await jest.advanceTimersByTimeAsync(200_000);

      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-budget')?.status).toBe(ITransactionStatus.Queued);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      // The loop drive, not just the timer. Both assertions below hold for a
      // chain that re-arms forever without ever calling
      // `safeGenerateTransactionsLoop` — the silent no-op this wake exists to
      // prevent, and which the row-status assertion cannot distinguish from a
      // working chain, since the row stays Queued either way.
      const loopRuns = () => repoMock.transactions.filter.mock.calls.length;
      const runsBefore = loopRuns();
      await jest.advanceTimersByTimeAsync(4_000);
      expect(loopRuns()).toBeGreaterThan(runsBefore);
    } finally {
      restoreLocks();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('keeps waking a row whose deadline an unrelated backoff pushed past the old fixed ceiling', async () => {
    // The retry budget is a wall clock that OTHER arms extend: a 429 from the
    // same overloaded guardian parks the row and pushes `unauthorizedRetryUntil`
    // out by its own cooldown. An earlier version fixed the chain's ceiling at
    // 10 minutes from the first wake, so a row that had waited out two clamped
    // 429s held a live deadline the chain had already stopped covering — Queued,
    // still retryable, and off-extension with nothing left to drive it.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    const restoreLocks = installNavigatorLocks();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-extended', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-extended', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Park the row on a clamped rate-limit cooldown, as the same overloaded
      // guardian readily does next. That is the shape that broke the old fixed
      // ceiling: two of these and the row is still waiting, still retryable,
      // ten minutes after the chain would have given up.
      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-extended') as Record<string, unknown>;
      stored.nextEligibleAt = Math.floor(Date.now() / 1000) + 600;

      // Well past the old 10-minute ceiling, and past the 180s budget too, but
      // still inside the queue's own 30-minute cap — where the row remains
      // Queued and therefore still needs a driver.
      await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-extended')?.status).toBe(ITransactionStatus.Queued);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      // The loop drive, not just the timer. Both assertions below hold for a
      // chain that re-arms forever without ever calling
      // `safeGenerateTransactionsLoop` — the silent no-op this wake exists to
      // prevent, and which the row-status assertion cannot distinguish from a
      // working chain, since the row stays Queued either way.
      const loopRuns = () => repoMock.transactions.filter.mock.calls.length;
      const runsBefore = loopRuns();
      await jest.advanceTimersByTimeAsync(4_000);
      expect(loopRuns()).toBeGreaterThan(runsBefore);
    } finally {
      restoreLocks();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('keeps waking a row past MAX_QUEUED_AGE, because the reaper it is waiting for runs inside the loop', async () => {
    // A row older than MAX_QUEUED_AGE looks like the chain's natural stopping
    // point: `cancelStaleQueuedTransactions` will fail it as expired, so the
    // wake has nothing left to do. That reasoning is circular. The reaper runs
    // INSIDE `generateTransactionsLoop`, which off-extension this wake is what
    // drives, and the drive takes the loop lock with `ifAvailable` — a lap that
    // loses it to a long-running pipeline reaps nothing. Stopping on age would
    // abandon the row on exactly the lap that failed to do the work, leaving it
    // Queued with nothing left to reap it.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    const restoreLocks = installNavigatorLocks();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-stale', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-stale', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Older than MAX_QUEUED_AGE (30 min) — a row the reaper WOULD take, if a
      // loop pass ever got the lock. The `filter` mock returns nothing, so here
      // none does, standing in for a lap that lost the lock.
      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-stale') as Record<string, unknown>;
      stored.initiatedAt = Math.floor(Date.now() / 1000) - 31 * 60;

      // Past the longest cooldown, so the first wake has fired and decided.
      await jest.advanceTimersByTimeAsync(60_000);

      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-stale')?.status).toBe(ITransactionStatus.Queued);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      // The loop drive, not just the timer. Both assertions below hold for a
      // chain that re-arms forever without ever calling
      // `safeGenerateTransactionsLoop` — the silent no-op this wake exists to
      // prevent, and which the row-status assertion cannot distinguish from a
      // working chain, since the row stays Queued either way.
      const loopRuns = () => repoMock.transactions.filter.mock.calls.length;
      const runsBefore = loopRuns();
      await jest.advanceTimersByTimeAsync(4_000);
      expect(loopRuns()).toBeGreaterThan(runsBefore);
    } finally {
      restoreLocks();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('drives a stale row at the reap boundary instead of sleeping out its cooldown first', async () => {
    // Past MAX_QUEUED_AGE the row's own cooldown stops being the right thing to
    // wait for: what it needs is a loop pass, so the reaper inside it can fail
    // the row with a reason. A row parked on a 429's clamped 300s cooldown would
    // otherwise sit five more minutes past the point it should already be gone.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    const restoreLocks = installNavigatorLocks();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-clamp', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-clamp', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Already past the reap boundary, and parked on a long rate-limit cooldown.
      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-clamp') as Record<string, unknown>;
      const nowSec = Math.floor(Date.now() / 1000);
      stored.initiatedAt = nowSec - 31 * 60;
      stored.nextEligibleAt = nowSec + 600;

      // Let the first wake fire and decide when to come back.
      await jest.advanceTimersByTimeAsync(60_000);
      const runsBefore = repoMock.transactions.filter.mock.calls.length;

      // Without the clamp the next drive is 10 minutes out, not seconds.
      await jest.advanceTimersByTimeAsync(5_000);
      expect(repoMock.transactions.filter.mock.calls.length).toBeGreaterThan(runsBefore);
    } finally {
      restoreLocks();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('stops the chain at its ceiling even when every row read fails', async () => {
    // The read-failure re-arm carries the chain's ORIGINAL start time. Carrying
    // the current time instead would push the ceiling out on every failed read,
    // so a row whose read never recovers would re-arm every three seconds for
    // the life of the process — the one thing the ceiling exists to stop.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-readfail-cap', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-readfail-cap', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Every read from here on throws.
      mockFailRowReads = { id: 'on-send-unauthorized-wake-readfail-cap', times: Number.MAX_SAFE_INTEGER };

      await jest.advanceTimersByTimeAsync(32 * 60 * 1000);

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('stops the chain when the row has vanished from the table', async () => {
    // A deleted row is not a waiting row. `row?.status !== Queued` is what makes
    // `undefined` a stop rather than a reason to keep coming back.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-gone', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-gone', row) as never,
        signCallback,
        false,
        provider as never
      );
      expect(jest.getTimerCount()).toBe(1);

      const idx = txStore.findIndex(r => r.id === 'on-send-unauthorized-wake-gone');
      txStore.splice(idx, 1);
      await jest.advanceTimersByTimeAsync(60_000);

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('caps the wake chain so a row that can never be driven cannot run timers forever', async () => {
    // The row stays Queued for the whole test, so only the cap can end the
    // chain. Without one, a row nothing will ever pick up leaves a timer chain
    // running for the life of the process. The cap is absolute and generous —
    // sized past MAX_QUEUED_AGE, because up to that point a Queued row still has
    // work owed to it (a retry, a terminal failure, or a reap) and off-extension
    // this wake is what runs it.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-cap', row);
      const warn = jest.spyOn(console, 'warn');

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-cap', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Past the absolute ceiling (MAX_QUEUED_AGE + 60s from the first wake).
      await jest.advanceTimersByTimeAsync(32 * 60 * 1000);
      // The other half of the boolean `cancelTransaction` now returns: this row
      // WAS expired here, and the log has to say so. Together with the declined
      // case asserted in the claimed-row test, this is what makes the return
      // value falsifiable rather than decorative.
      const ceilingLogs = warn.mock.calls
        .map(call => String(call[0]))
        .filter(line => line.includes('absolute ceiling'));
      warn.mockRestore();
      expect(ceilingLogs).toHaveLength(1);
      expect(ceilingLogs[0]).toContain('expired the row');

      // Terminal, NOT still Queued. Off-extension this chain is the only thing
      // that would ever drive the row, so a ceiling that merely stopped would
      // leave it Queued with nothing watching it — the exact silent no-op the
      // wake exists to prevent, and the reaper cannot be assumed to have run
      // because it needs a lap that won the loop lock.
      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-cap')?.status).toBe(ITransactionStatus.Failed);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('does not expire a fresh incarnation of the row the chain started on', async () => {
    // `requeueFailedTransaction` refreshes `initiatedAt` on the SAME row id, and
    // the wake map is keyed by id, so a user who cancels and retries mid-chain
    // hands the old chain a transaction it never started timing. Expiring that
    // on the inherited deadline tells the user their minutes-old retry "expired
    // after being queued too long" — and the reaper, which this ceiling claims
    // only to be standing in for, would not have touched it.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adoptions = () =>
      warn.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('adopted a newer row')).length;
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-reborn', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-reborn', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Most of the way to the ceiling, then the user retries: same id, fresh
      // `initiatedAt`, as `requeueFailedTransaction` writes it.
      await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-reborn') as Record<string, unknown>;
      stored.initiatedAt = Math.floor(Date.now() / 1000);

      await jest.advanceTimersByTimeAsync(12 * 60 * 1000);

      // Still alive, and still being driven — the new incarnation gets its own
      // chain rather than inheriting a deadline that was never about it.
      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-reborn')?.status).toBe(ITransactionStatus.Queued);
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      // The chain is FRESH, not merely alive. Hand the adoption the old
      // `chainStartedAt` and the row survives this far all the same, but every
      // 3s lap lands back on an already-expired ceiling and re-adopts — a row
      // that is driven, yet can never again reach the expiry the ceiling exists
      // to produce. One adoption, not a cadence of them, is what distinguishes
      // the two.
      expect(adoptions()).toBe(1);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(adoptions()).toBe(1);
    } finally {
      warn.mockRestore();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it.each([
    ['absent', undefined],
    ['a whole day ahead of the clock', () => Math.floor(Date.now() / 1000) + 86_400]
  ])('expires a row whose initiatedAt is %s, rather than adopting it forever', async (_label, stamp) => {
    // The adoption branch asks "is this row younger than the reaper's cap?". An
    // absent stamp answers NaN, which loses every comparison, and a stamp a day
    // in the future is not a clock skew — it is a stamp that means nothing.
    // Routed to adoption, either re-arms a chain whose ceiling reaches the same
    // answer 31 minutes later, forever, and the reaper it defers to filters on
    // the same comparison so it will never take the row either. The ceiling is
    // the only thing that can end it.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-noage', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-noage', row) as never,
        signCallback,
        false,
        provider as never
      );

      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-noage') as Record<string, unknown>;
      if (stamp === undefined) delete stored.initiatedAt;
      else stored.initiatedAt = stamp();

      await jest.advanceTimersByTimeAsync(32 * 60 * 1000);

      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-noage')?.status).toBe(ITransactionStatus.Failed);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('adopts a row a minute ahead of the clock instead of expiring it', async () => {
    // The MAGNITUDE of the discrepancy is what disqualifies a stamp, not its
    // sign — the rule `pipelineMayStillBeRunning` already states for this same
    // arithmetic, where a small skew stays live and errs toward funds safety. A
    // predicate rejecting every negative age fails a row a user retried a moment
    // before an NTP correction stepped the clock back, and reports it to them as
    // "expired after being queued too long" seconds into its life. The day-ahead
    // case above still expires, so the two halves of the bound are separated.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn');
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-skew', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-skew', row) as never,
        signCallback,
        false,
        provider as never
      );

      const stored = txStore.find(r => r.id === 'on-send-unauthorized-wake-skew') as Record<string, unknown>;
      // Stamped so the age is a SMALL negative number at the moment the ceiling
      // reads it, ~31 minutes from now — a clock stepped back under a row that
      // was retried, not a stamp from another epoch.
      stored.initiatedAt = Math.floor(Date.now() / 1000) + 32 * 60 + 1;

      await jest.advanceTimersByTimeAsync(32 * 60 * 1000);

      const adoptions = warn.mock.calls.filter(call => String(call[0]).includes('adopted a newer row')).length;
      warn.mockRestore();
      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-skew')?.status).toBe(ITransactionStatus.Queued);
      expect(adoptions).toBe(1);
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('does not expire a row at the ceiling that another driver has just picked up', async () => {
    // The expiry runs OUTSIDE the loop lock, so unlike the reaper it imitates it
    // races every other driver. A row past its cooldown can be advanced to
    // GeneratingTransaction between the ceiling's read and its write, and failing
    // that row would report a failure for a pipeline that is still running and
    // can still submit — the double-send shape this whole arm is careful about.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockPlatformIsExtension = false;
    jest.useFakeTimers();
    // Pinned, because the whole test turns on WHICH read consumes the one-shot.
    // The first wake lands a jittered cooldown after the requeue and every later
    // lap is exactly REQUEUE_WAKE_REARM_MS after that, so an unpinned draw shifts
    // the lap phase and can let an ORDINARY lap take the claim instead of the
    // ceiling's. That still leaves the row in GeneratingTransaction, so the
    // assertion below passes with the guard removed — the test looks green while
    // testing nothing.
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    // Silenced for as long as the draw is constant, and that is the POINT rather
    // than noise reduction. Jest formats each console line as it is written, and
    // that formatting sorts source maps with `Math.random` as its pivot — with a
    // constant draw the sort degenerates and throws, so the run reports
    // `RangeError: Maximum call stack size exceeded` INSTEAD of the expectation
    // that failed. Restoring the draw before the assertion does not help: the
    // overflow already happened, inside `generateTransaction`, when production
    // logged. No console output while the draw is pinned means nothing to sort.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-wake-claimed', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-wake-claimed', row) as never,
        signCallback,
        false,
        provider as never
      );

      // Run right up to the ceiling first. The claim has to land on the CEILING's
      // read, so it is armed only once the next lap is the one that crosses:
      // armed earlier, an ordinary lap consumes it and the chain simply stops on
      // a non-Queued row, which would exercise nothing.
      await jest.advanceTimersByTimeAsync(31 * 60 * 1000 - 2_000);
      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-claimed')?.status).toBe(ITransactionStatus.Queued);

      // Occupy the gap: the ceiling reads Queued, a driver claims the row, and
      // only then does the write land.
      mockClaimRowOnRead = { id: 'on-send-unauthorized-wake-claimed' };
      // Zeroed here so the count below belongs to the CEILING's write and not to
      // any earlier decline in the run.
      mockDeclinedWrites = 0;
      await jest.advanceTimersByTimeAsync(10_000);

      const ceilingLogs = warn.mock.calls
        .map(call => String(call[0]))
        .filter(line => line.includes('absolute ceiling'));
      random.mockRestore();
      warn.mockRestore();
      error.mockRestore();

      // Left alone. The running pipeline owns this row's outcome.
      expect(txStore.find(r => r.id === 'on-send-unauthorized-wake-claimed')?.status).toBe(
        ITransactionStatus.GeneratingTransaction
      );
      // The log has to say which of the two things happened, because it is the
      // only record of it. Asserted rather than assumed: `cancelTransaction`'s
      // boolean is otherwise mutation-dead — dropping its `applied` bookkeeping
      // leaves every other assertion green while this line claims the row was
      // expired when it was not.
      expect(ceilingLogs).toHaveLength(1);
      expect(ceilingLogs[0]).toContain('another driver had already taken it');
      expect(ceilingLogs[0]).not.toContain('expired the row');
      // The declining write returned `false`, so Dexie skipped the put. Written
      // as a bare `return` it would have re-put the unchanged clone and fired a
      // `liveQuery` event for a write that changed nothing — invisible in any
      // field assertion, since the clone matches the row.
      expect(mockDeclinedWrites).toBeGreaterThan(0);
      // And the row is still being watched: a declined expiry means someone else
      // owns the attempt, and that attempt can requeue rather than finish.
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    } finally {
      random.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      jest.clearAllTimers();
      jest.useRealTimers();
      mockPlatformIsExtension = true;
    }
  });

  it('on extension, no wake is armed — the service worker already drives the queue', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    jest.useFakeTimers();
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-nowake', row);

      await generateTransaction(
        buildTx('on-send-unauthorized-nowake', row) as never,
        signCallback,
        false,
        provider as never
      );

      expect(txStore.find(r => r.id === 'on-send-unauthorized-nowake')?.status).toBe(ITransactionStatus.Queued);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('an unauthorized earn-deposit stays Failed — its caller is waiting on the result', async () => {
    // `earn-deposit` is result-awaiting (`isResultAwaitingRow`): the Epoch flow
    // reads `resultBytes` / `outputNoteIds` back off the finished row. Requeueing
    // one leaves that caller waiting on a row that will not finish this cycle,
    // which is the same hang the neighbouring post-submit branch fails the row to
    // avoid. Its collateral note is also bound to an allocator mandate, so it is
    // not a transfer that can simply be rebuilt. It must fail rather than retry,
    // even though the error is the same recoverable race for every other type.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
          'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
      )
    );
    const row = {
      type: 'earn-deposit',
      secondaryAccountId: 'r',
      faucetId: 'f',
      amount: '5',
      requestBytes: new Uint8Array([4, 4]),
      extraInputs: { recallBlocks: 10 }
    };
    arrange('on-earn-unauthorized', row);

    await generateTransaction(buildTx('on-earn-unauthorized', row) as never, signCallback, false, provider as never);

    const stored = txStore.find(r => r.id === 'on-earn-unauthorized') as Record<string, unknown>;
    expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
    expect(stored.status).toBe(ITransactionStatus.Failed);
    expect(stored.nextEligibleAt).toBeUndefined();
  });

  it('stops requeueing an unauthorized send once it has outlived the retry window', async () => {
    // The race clears in a block or two, so a row still being rejected minutes
    // later is not racing — it is genuinely unauthorized (a rotated-out key, a
    // missing co-signature). Retrying it until MAX_QUEUED_AGE would hold the user
    // on a progress screen for 30 minutes and then replace the real reason with a
    // generic "expired", which is strictly worse than the terminal failure this
    // change replaced. Past the window it fails with the reason it actually got.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
          'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
      )
    );
    const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    arrange('on-send-unauthorized-aged', row);
    // A row that has already spent its retry budget: the deadline stamped by an
    // earlier unauthorized failure is in the past. Well inside MAX_QUEUED_AGE, so
    // the only thing that can fail it is this arm giving up, not the reaper.
    const stored0 = txStore.find(r => r.id === 'on-send-unauthorized-aged') as Record<string, unknown>;
    stored0.unauthorizedRetryUntil = Math.floor(Date.now() / 1000) - 60;

    await generateTransaction(
      buildTx('on-send-unauthorized-aged', row) as never,
      signCallback,
      false,
      provider as never
    );

    const stored = txStore.find(r => r.id === 'on-send-unauthorized-aged') as Record<string, unknown>;
    expect(stored.status).toBe(ITransactionStatus.Failed);
    expect(stored.nextEligibleAt).toBeUndefined();
    // The whole point of giving up early is that the user gets the reason they
    // actually got. If this row ages out to the reaper instead, that text is
    // replaced by a generic "expired" and the diagnosis is lost.
    expect(String(stored.error)).toMatch(/transaction is unauthorized/i);
  });

  it('does not park an unauthorized send on a cooldown that outlives its retry window', async () => {
    // Being inside the deadline is not the same as having room to retry: the
    // cooldown runs up to 54s, so a failure with seconds left would requeue,
    // wait most of a minute, and then fail on arrival for the reason it already
    // had. The user waits longer to see the same error, and no retry that could
    // have succeeded is lost. Fail now instead.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
          'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
      )
    );
    const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    arrange('on-send-unauthorized-nowindow', row);
    // Still inside the deadline — 10s left — but under the 15s MINIMUM cooldown,
    // so no draw of the jitter can schedule an attempt that lands in time.
    const stored0 = txStore.find(r => r.id === 'on-send-unauthorized-nowindow') as Record<string, unknown>;
    stored0.unauthorizedRetryUntil = Math.floor(Date.now() / 1000) + 10;

    await generateTransaction(
      buildTx('on-send-unauthorized-nowindow', row) as never,
      signCallback,
      false,
      provider as never
    );

    const stored = txStore.find(r => r.id === 'on-send-unauthorized-nowindow') as Record<string, unknown>;
    expect(stored.status).toBe(ITransactionStatus.Failed);
    expect(String(stored.error)).toMatch(/transaction is unauthorized/i);
  });

  it('fails a retry whose cooldown lands exactly ON the deadline, not a beat inside it', async () => {
    // The boundary itself. A cooldown that ends exactly at the deadline buys an
    // attempt that arrives with zero budget and fails the same way, so `<` is
    // right and `<=` would spend a full cooldown to learn nothing. Nothing else
    // in the suite separates the two: every other fixture sits well clear of the
    // edge, so relaxing the comparison passes them all.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    // Time is pinned as well as the jitter. The fixture derives the deadline from
    // one `Date.now()` and production reads its own later; if the wall clock
    // crosses a second between them the row fails for the ORDINARY reason and the
    // test passes under `<=` too, quietly ceasing to pin the boundary it names.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    // Silenced while the draw is constant — see the claimed-row test above: jest
    // formats console lines through a source-map sort pivoted on `Math.random`,
    // and a constant draw turns a failure here into a stack overflow with no
    // expectation printed.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockDispatchGuardianPipeline.mockRejectedValue(
        new Error(
          "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
            'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
        )
      );
      const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
      arrange('on-send-unauthorized-exactly-at', row);
      // random()=0 pins the cooldown to the 15s floor, so a deadline exactly 15s
      // out makes `nowSec + cooldownSec` and the deadline the same number.
      const stored0 = txStore.find(r => r.id === 'on-send-unauthorized-exactly-at') as Record<string, unknown>;
      stored0.unauthorizedRetryUntil = Math.floor(Date.now() / 1000) + 15;

      await generateTransaction(
        buildTx('on-send-unauthorized-exactly-at', row) as never,
        signCallback,
        false,
        provider as never
      );

      const stored = txStore.find(r => r.id === 'on-send-unauthorized-exactly-at') as Record<string, unknown>;
      random.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      expect(stored.status).toBe(ITransactionStatus.Failed);
    } finally {
      random.mockRestore();
      now.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('treats an error that reports BOTH a mempool accept and an execution failure as submitted', async () => {
    // The arm's safety rests on `isApplyAfterSubmitError` being consulted first:
    // that one means the transaction REACHED THE CHAIN, so requeueing on it would
    // broadcast the transfer twice. The two classifiers are disjoint on every SDK
    // string today, which is exactly why nothing would go red if the arms were
    // reordered. This fixture makes the order load-bearing by handing the catch
    // chain text both would claim.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: transaction execution failed: " +
          'transaction is unauthorized with summary TransactionSummary {}, and the transaction was ' +
          "accepted into the node's mempool but the local store update failed"
      )
    );
    const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    arrange('on-send-unauthorized-and-submitted', row);

    await generateTransaction(
      buildTx('on-send-unauthorized-and-submitted', row) as never,
      signCallback,
      false,
      provider as never
    );

    // Completed, specifically, and not merely "not Queued". The row is picked up
    // as GeneratingTransaction, so a `not.toBe(Queued)` assertion also passes if
    // the apply-after-submit arm stops writing anything at all — leaving the
    // status untouched at pickup value and pinning nothing. Asserting the arm's
    // actual verdict is what makes the ordering load-bearing.
    const stored = txStore.find(r => r.id === 'on-send-unauthorized-and-submitted') as Record<string, unknown>;
    expect(mockDispatchGuardianPipeline).toHaveBeenCalled();
    expect(stored.status).toBe(ITransactionStatus.Completed);
  });

  it('stamps a retry deadline on the first unauthorized failure and keeps it across cycles', async () => {
    // The budget has to run from the first FAILURE, not from enqueue: under the
    // queue depth this arm exists to survive, a row can wait longer than the whole
    // window before its first attempt, and an enqueue-based clock would give it
    // zero retries — a silent no-op exactly when it is needed.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(
      new Error(
        "Offscreen call 'guardianPipeline' failed: failed to execute transaction: " +
          'transaction execution failed: transaction is unauthorized with summary TransactionSummary {}'
      )
    );
    const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    arrange('on-send-unauthorized-deadline', row);
    // Enqueued far longer ago than the retry window — an enqueue-based bound
    // would refuse to retry this at all. Still inside MAX_QUEUED_AGE (30 min),
    // so the row is one the queue would really hand to this arm: past that the
    // loop's own reaper takes it first and the scenario cannot arise.
    const stored0 = txStore.find(r => r.id === 'on-send-unauthorized-deadline') as Record<string, unknown>;
    stored0.initiatedAt = Math.floor(Date.now() / 1000) - 20 * 60;
    const before = Math.floor(Date.now() / 1000);

    await generateTransaction(
      { ...buildTx('on-send-unauthorized-deadline', row), initiatedAt: stored0.initiatedAt } as never,
      signCallback,
      false,
      provider as never
    );

    const first = txStore.find(r => r.id === 'on-send-unauthorized-deadline') as Record<string, unknown>;
    expect(first.status).toBe(ITransactionStatus.Queued);
    // Bounded on BOTH sides. A lower bound alone lets the window be widened to
    // half an hour — the exact outcome the budget exists to prevent — without
    // reddening anything.
    expect(Number(first.unauthorizedRetryUntil)).toBeGreaterThanOrEqual(before + 180);
    expect(Number(first.unauthorizedRetryUntil)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 180);

    // Second cycle: the deadline must NOT be pushed out, or the budget renews
    // every cycle and the row retries forever. Seeded with a distinctive value
    // rather than compared to the first write — both cycles land in the same
    // wall-clock second, so `now + 180` twice over would compare equal and a
    // renew-every-cycle bug would read as a pass.
    // Still live, with room for another cooldown, so the arm takes the requeue
    // branch — and distinct from any `now + 180` the branch could write.
    const seeded = before + 100;
    first.unauthorizedRetryUntil = seeded;
    await generateTransaction(
      { ...buildTx('on-send-unauthorized-deadline', row), initiatedAt: stored0.initiatedAt } as never,
      signCallback,
      false,
      provider as never
    );
    const second = txStore.find(r => r.id === 'on-send-unauthorized-deadline') as Record<string, unknown>;
    expect(second.status).toBe(ITransactionStatus.Queued);
    expect(Number(second.unauthorizedRetryUntil)).toBe(seeded);
  });

  it('delegated flag ON forwards delegateTransaction=true to the offscreen leaf', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockResolvedValue(makeResult());
    arrange('on-send-delegated', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' });

    await generateTransaction(
      buildTx('on-send-delegated', {
        type: 'send',
        secondaryAccountId: 'r',
        faucetId: 'f',
        amount: '1',
        delegateTransaction: true
      }) as never,
      signCallback,
      false,
      provider as never
    );

    expect(mockDispatchGuardianPipeline.mock.calls[0][2]).toBe(true);
  });

  // #784: the co-signatures were collected over a summary that binds the
  // proposal's reference block, so the offscreen realm must execute AT that
  // block. The anchor crosses in its wire form — the proposal metadata's base64
  // string — and is decoded offscreen-side (a WASM ChainAnchor cannot cross the
  // message boundary).
  it('crosses the proposal chain anchor to dispatchGuardianPipeline in its wire-form base64 (#784)', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockResolvedValue(makeResult());
    const row = { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    const { service } = arrange('on-send-anchored', row);
    service.createSendProposal.mockResolvedValue({
      id: 'prop',
      nonce: 7,
      metadata: { proposalType: 'p2id', description: 'send', chainAnchor: 'BwcH' }
    } as never);

    await generateTransaction(buildTx('on-send-anchored', row) as never, signCallback, false, provider as never);

    expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
    expect(mockDispatchGuardianPipeline.mock.calls[0][5]).toBe('BwcH');
  });
});

// ─── PR #524 × #260: the guardian leaf's per-step stage stamps, on BOTH flags ──
//
// `runGuardianPipeline` has always stamped `executing` / `proving` / `submitting`
// as it runs; the generating-transaction screen turns those persisted stamps into a
// duration per step and into the active-step highlight. Guardian is the wallet's
// DEFAULT account type and the SW build (vite.background.config.ts) is the one build
// that defaults MIDEN_USE_OFFSCREEN_CLIENT ON, so a stamp that rode the inline leaf
// only would blank the default send flow's step timings on Chrome — and skip the
// `submitting` highlight entirely, since no other writer stamps it.
describe('guardian leaf per-step stage stamps (PR #524 × #260)', () => {
  /** The leaf's three stamps, in the order the row recorded them. The row also
   * carries the surrounding coarse stages (`syncing`, `creating-proposal`, …); the
   * leaf boundaries are what the two paths must agree on. */
  const leafStamps = (id: string): string[] => {
    const stamps = txStore.find(r => r.id === id)?.stageTimestamps as Record<string, number> | undefined;
    return Object.keys(stamps ?? {}).filter(s => s === 'executing' || s === 'proving' || s === 'submitting');
  };

  it('flag ON stamps the SAME three boundaries as flag OFF, replayed through the callback the offscreen leaf is handed', async () => {
    // Flag OFF: the inline pipeline stamps as it drives execute → prove → submit.
    arrange('stage-parity-off', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' });
    await generateTransaction(
      buildTx('stage-parity-off', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' }) as never,
      signCallback,
      false,
      provider as never
    );

    // Flag ON: the offscreen leaf posts an OFFSCREEN_STAGE_EVENT per boundary and the
    // proxy replays each through the callback it was handed — modelled here by
    // invoking that callback at the same three points.
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockImplementation(async (..._args: unknown[]) => {
      const onStage = _args[4] as (s: string) => Promise<void>;
      await onStage('executing');
      await onStage('proving');
      await onStage('submitting');
      return makeResult();
    });
    arrange('stage-parity-on', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' });
    await generateTransaction(
      buildTx('stage-parity-on', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' }) as never,
      signCallback,
      false,
      provider as never
    );

    // A fifth argument EXISTS flag-ON — without it the offscreen realm has nowhere to
    // deliver its stamps and the whole default send flow renders blank durations.
    expect(typeof mockDispatchGuardianPipeline.mock.calls[0][4]).toBe('function');
    expect(leafStamps('stage-parity-off')).toEqual(['executing', 'proving', 'submitting']);
    expect(leafStamps('stage-parity-on')).toEqual(leafStamps('stage-parity-off'));
  });

  it('flag OFF: a stamp whose row write REJECTS never fails the guardian write (a stamp is telemetry)', async () => {
    // The inline leaf AWAITS its stage callback (`await setStage('proving')`), so an
    // unguarded Dexie failure there would propagate out of the leaf, hit the guardian
    // catch, abandon the candidate and Fail a transaction that was about to prove.
    mockThrowOnStageWrite = 'proving';
    const { service, inline } = arrange('stage-throw-off', {
      type: 'send',
      secondaryAccountId: 'r',
      faucetId: 'f',
      amount: '1'
    });

    await generateTransaction(
      buildTx('stage-throw-off', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' }) as never,
      signCallback,
      false,
      provider as never
    );

    // The leaf ran to completion and the send finalized normally: no abandon, no Failed.
    expect(inline.__executeRequest).toHaveBeenCalledTimes(1);
    expect(service.abandonCandidate).not.toHaveBeenCalled();
    expect(mockComplete.send).toHaveBeenCalledTimes(1);
    expect(txStore.find(r => r.id === 'stage-throw-off')!.status).not.toBe(ITransactionStatus.Failed);
  });
});

// The double-send guard has to be written by the LEAF, at the point it commits
// to broadcasting, because the row's `stage` cannot be trusted to record it: a
// concurrent `cancelTransaction` (Cancel button, stale-queued reaper) makes the
// row terminal without aborting the pipeline, and `setTransactionStage` then
// silently drops every later stage write. The leaf submits anyway, the row stays
// frozen at 'proving', and Retry reads that as proof nothing was broadcast —
// rebuilding the serial that is the only reason the chain would reject the
// duplicate. Both leaves must therefore stamp `mayHaveSubmitted` themselves.
describe('guardian leaf records the submit crossing', () => {
  it('flag OFF: the inline leaf stamps mayHaveSubmitted', async () => {
    arrange('cross-inline', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' });

    await generateTransaction(
      buildTx('cross-inline', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' }) as never,
      signCallback,
      false,
      provider as never
    );

    expect(txStore.find(r => r.id === 'cross-inline')!.mayHaveSubmitted).toBe(true);
  });

  // The offscreen leaf has no stage to narrow — the realm reports none — so the
  // flag must be durable BEFORE the bytes cross, since after that the wallet
  // cannot tell whether the realm submitted. Asserted from inside the dispatch.
  //
  // But only where there are bytes for it to protect. The flag is permanent, and
  // `requeueFailedTransaction` refuses a send carrying it with no bytes and no
  // captured id, so stamping a byteless row pre-emptively does not err safe — it
  // bricks Retry on the row's first failure. Hence the pair below, which differ
  // only in whether a request was cached.
  const dispatchRecording = (id: string) => {
    let flagAtDispatch: unknown;
    mockDispatchGuardianPipeline.mockImplementation(async () => {
      flagAtDispatch = txStore.find(r => r.id === id)!.mayHaveSubmitted;
      return makeResult();
    });
    return () => flagAtDispatch;
  };

  it('flag ON: stamps before dispatch when a cached request is at stake', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    // A recallable send: the cached bytes pin the note id, which is the only
    // reason the chain would reject a duplicate — exactly what the flag protects.
    const row = {
      type: 'send' as const,
      secondaryAccountId: 'r',
      faucetId: 'f',
      amount: '1',
      requestBytes: new Uint8Array([9, 9]),
      extraInputs: { recallBlocks: 100 }
    };
    const flagAtDispatch = dispatchRecording('cross-offscreen');
    arrange('cross-offscreen', row);

    await generateTransaction(buildTx('cross-offscreen', row) as never, signCallback, false, provider as never);

    expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
    expect(flagAtDispatch()).toBe(true);
  });

  it('flag ON: does not stamp a non-recallable send, which caches nothing to protect', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    // No recall window → `createSendProposal` → no cached request. Stamping here
    // would refuse this row's very first Retry, the vault-slot failure included.
    const row = { type: 'send' as const, secondaryAccountId: 'r', faucetId: 'f', amount: '1' };
    const flagAtDispatch = dispatchRecording('cross-offscreen-bare');
    arrange('cross-offscreen-bare', row);

    await generateTransaction(buildTx('cross-offscreen-bare', row) as never, signCallback, false, provider as never);

    expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
    expect(flagAtDispatch()).toBeUndefined();
  });
});

// ─── Slice 7c: bridged-send / earn-deposit guardian leaf → offscreen ──────────
// The final two value-moving guardian types. Before 7c they ran the leaf INLINE
// even flag-ON (excluded from OFFSCREEN_ROUTABLE_GUARDIAN_TYPES) → the dormant SW
// client. 7c routes them offscreen exactly like send/swap, since their co-signed
// `tr` crosses the same serializable waist.

describe('guardian bridged-send / earn-deposit leaf routing — flag OFF (inline)', () => {
  it.each(bridgeEarnCases())(
    '$type: runs the inline pipeline, never dispatchGuardianPipeline',
    async ({ row, complete }) => {
      const { service, inline } = arrange(`be-off-${row.type}`, row);

      await generateTransaction(buildTx(`be-off-${row.type}`, row) as never, signCallback, false, provider as never);

      expect(inline.__executeRequest).toHaveBeenCalledTimes(1);
      expect(mockDispatchGuardianPipeline).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(service.abandonCandidate).not.toHaveBeenCalled();
    }
  );
});

describe('guardian bridged-send / earn-deposit leaf routing — flag ON (offscreen)', () => {
  it.each(bridgeEarnCases())(
    '$type: crosses the co-signed request bytes to dispatchGuardianPipeline, never runs the inline leaf',
    async ({ row, complete }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      const dispatched = makeResult();
      mockDispatchGuardianPipeline.mockResolvedValue(dispatched);
      const { inline } = arrange(`be-on-${row.type}`, row);

      await generateTransaction(buildTx(`be-on-${row.type}`, row) as never, signCallback, false, provider as never);

      // The inline SW leaf never executed; the offscreen leaf did.
      expect(inline.__executeRequest).not.toHaveBeenCalled();
      expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
      const [acct, trBytes, delegate, cb] = mockDispatchGuardianPipeline.mock.calls[0];
      expect(acct).toBe('guardian-acc');
      // §4.0: the co-signed request crossed as the EXACT serialized bytes.
      expect(Array.from(trBytes as Uint8Array)).toEqual(TR_BYTES);
      expect(delegate).toBe(false);
      expect(cb).toBe(signCallback);
      // Same completion handler finalized with the round-tripped result.
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]).toContain(dispatched);
    }
  );
});

describe('guardian bridged-send / earn-deposit byte-identity — flag ON result bytes == flag OFF result bytes', () => {
  it.each(bridgeEarnCases())(
    '$type: completion handler receives identical serialize() bytes on both paths',
    async ({ row, complete }) => {
      arrange(`be-bi-off-${row.type}`, row, makeResult([7, 7, 7]));
      await generateTransaction(buildTx(`be-bi-off-${row.type}`, row) as never, signCallback, false, provider as never);
      const offResult = complete.mock.calls[0][complete.mock.calls[0].length - 1] as ReturnType<typeof makeResult>;

      jest.clearAllMocks();
      txStore.length = 0;
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      mockDispatchGuardianPipeline.mockResolvedValue(makeResult([7, 7, 7]));
      arrange(`be-bi-on-${row.type}`, row, makeResult([7, 7, 7]));
      await generateTransaction(buildTx(`be-bi-on-${row.type}`, row) as never, signCallback, false, provider as never);
      const onResult = complete.mock.calls[0][complete.mock.calls[0].length - 1] as ReturnType<typeof makeResult>;

      expect(Array.from(offResult.serialize())).toEqual(Array.from(onResult.serialize()));
      expect(Array.from(onResult.serialize())).toEqual([7, 7, 7]);
    }
  );
});

describe('guardian bridged-send / earn-deposit kill-window (funds-safety) — an offscreen kill FAILS the row, no auto-requeue', () => {
  it.each(bridgeEarnCases())(
    '$type: an OperationAbortedError marks the row Failed, does NOT requeue, and dispatches exactly ONCE (no double-send)',
    async ({ row, complete }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      // A wedge-kill fires AFTER the offscreen submit may have landed → retryable
      // OperationAbortedError. bridged-send has no input-note nullifier (fresh
      // proposal each retry) and is only USER-tap-requeueable (never auto); earn-deposit
      // is excluded from REQUEUEABLE_TYPES entirely — so falling through to Failed with
      // NO auto-requeue is the only funds-safe outcome, matching the non-guardian 7b
      // path and guardian flag-OFF.
      mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
      const { service } = arrange(`be-kill-${row.type}`, row);

      await generateTransaction(buildTx(`be-kill-${row.type}`, row) as never, signCallback, false, provider as never);

      expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
      expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
      expect(service.abandonCandidate).toHaveBeenCalledWith(7);
      const finalRow = txStore.find(r => r.id === `be-kill-${row.type}`)!;
      expect(finalRow.status).toBe(ITransactionStatus.Failed);
      expect(finalRow.status).not.toBe(ITransactionStatus.Queued);
      expect(finalRow.nextEligibleAt).toBeUndefined();
      expect(complete).not.toHaveBeenCalled();
    }
  );
});

describe('guardian bridged-send / earn-deposit errorCode preservation → classifier routes on the ROW, not the type alone', () => {
  /**
   * A round-tripped `ApplyTransactionAfterSubmitFailed` means the submit LANDED and
   * only the local apply threw. What that should do to the row depends on whether
   * anything is awaiting the row's `resultBytes` / `outputNoteIds`:
   *
   *   - `earn-deposit` and EPOCH `bridged-send` → Failed. `createEarnP2IDNote` /
   *     `createBridgeP2IDNote` block on `waitForTransactionCompletion` and read those
   *     fields back; there is no `TransactionResult` here to repopulate them from, so
   *     the caller must resolve via its error branch. The recallable P2IDE collateral
   *     note reclaims itself at its recall height.
   *   - AGGLAYER `bridged-send` → Completed. `initiateB2AggBridge` returns the txId
   *     immediately and never awaits the row, and the B2AGG note is on chain. Failing
   *     it would hide the only in-wallet L1 claim path (`BridgeClaimSection` gates the
   *     deposit tracker and the Connect-wallet / Claim-Asset block on `status !==
   *     Failed`) on funds that already left the account.
   *
   * Either way the preserved `errorCode` is what the classifier reads, which is what
   * this suite exists to prove survives the offscreen round-trip.
   */
  // `bridgeEarnCases()`'s bridged-send row is the AGGLAYER route (pre-built
  // `requestBytes`). The Epoch counterpart needs a whole recallable-P2IDE build to
  // reach this point, so its Failed outcome is pinned in transactions.guardian.test.ts
  // ('Guardian bridged-send: submit lands but local apply fails') instead.
  const applyCases = () => [
    { label: 'earn-deposit', ...bridgeEarnCases()[1]!, expected: ITransactionStatus.Failed },
    { label: 'bridged-send (agglayer)', ...bridgeEarnCases()[0]!, expected: ITransactionStatus.Completed }
  ];

  it.each(applyCases())(
    '$label: a round-tripped ApplyTransactionAfterSubmitFailed reaches the classifier',
    async ({ label, row, complete, expected }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      const id = `be-apply-${label}`;
      const applyErr: Error & { errorCode?: string } = new Error('local apply failed after submit');
      applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
      mockDispatchGuardianPipeline.mockRejectedValue(applyErr);
      const { service } = arrange(id, row);

      await generateTransaction(buildTx(id, row) as never, signCallback, false, provider as never);

      const finalRow = txStore.find(r => r.id === id)!;
      expect(finalRow.status).toBe(expected);
      // The candidate proposal is abandoned either way — that happens in
      // `generateGuardianTransaction`'s own catch, before the classification above.
      expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
      // No `TransactionResult` exists on this path, so the completion handler never
      // runs regardless of which terminal status the row lands on.
      expect(complete).not.toHaveBeenCalled();
    }
  );
});

describe('guardian leaf byte-identity — flag ON result bytes == flag OFF result bytes', () => {
  it.each(valueMovingCases())(
    '$type: completion handler receives identical serialize() bytes on both paths',
    async ({ row, complete }) => {
      // Flag OFF: inline leaf returns a result serializing to [7,7,7].
      arrange(`bi-off-${row.type}`, row, makeResult([7, 7, 7]));
      await generateTransaction(buildTx(`bi-off-${row.type}`, row) as never, signCallback, false, provider as never);
      const offResult = complete.mock.calls[0][complete.mock.calls[0].length - 1] as ReturnType<typeof makeResult>;

      // Flag ON: the offscreen leaf returns a result serializing to the SAME [7,7,7].
      jest.clearAllMocks();
      txStore.length = 0;
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      mockDispatchGuardianPipeline.mockResolvedValue(makeResult([7, 7, 7]));
      arrange(`bi-on-${row.type}`, row, makeResult([7, 7, 7]));
      await generateTransaction(buildTx(`bi-on-${row.type}`, row) as never, signCallback, false, provider as never);
      const onResult = complete.mock.calls[0][complete.mock.calls[0].length - 1] as ReturnType<typeof makeResult>;

      expect(Array.from(offResult.serialize())).toEqual(Array.from(onResult.serialize()));
      expect(Array.from(onResult.serialize())).toEqual([7, 7, 7]);
    }
  );
});

describe('guardian leaf kill-window (funds-safety) — an offscreen kill FAILS the row, no auto-requeue', () => {
  // CONSUME is excluded here: #260 follow-up #3a node-verifies a killed consume
  // (its input noteId is known pre-execute) and marks it Completed when the note
  // landed — covered in the dedicated consume block below. send/swap/execute keep
  // the terminal-Failed behavior (no node-checkable post-kill identity).
  it.each(valueMovingCases().filter(c => c.type !== 'consume'))(
    '$type: an OperationAbortedError marks the row Failed, does NOT requeue, and dispatches exactly ONCE (no double-send)',
    async ({ row, complete }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      // A deadline/`closeDocument` wedge-kill fires AFTER the offscreen submit may
      // have already landed on chain → retryable OperationAbortedError. A guardian
      // send/swap/execute has NO input-note nullifier — each retry builds a FRESH
      // proposal (new random output-note serial) gated only by the account nonce —
      // so auto-requeueing would let the retry build a SECOND valid send and
      // DOUBLE-SEND (the recipient gets a second note, the account is debited twice).
      // The abort must therefore fall through to Failed, exactly like the proven
      // non-guardian path (slices 5a/5b) and guardian flag-OFF, and must NOT requeue.
      mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
      const { service } = arrange(`kill-${row.type}`, row);

      await generateTransaction(buildTx(`kill-${row.type}`, row) as never, signCallback, false, provider as never);

      // Dispatched exactly ONCE — the abort did NOT trigger a second offscreen submit.
      expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
      // The SW submit-catch abandoned the guardian candidate (idempotent), exactly once.
      expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
      expect(service.abandonCandidate).toHaveBeenCalledWith(7);
      // The row is terminally FAILED — NOT requeued to Queued (which would let a fresh
      // retry double-send), and carries no requeue cooldown stamp.
      const finalRow = txStore.find(r => r.id === `kill-${row.type}`)!;
      expect(finalRow.status).toBe(ITransactionStatus.Failed);
      expect(finalRow.status).not.toBe(ITransactionStatus.Queued);
      expect(finalRow.nextEligibleAt).toBeUndefined();
      // No value-moving completion ran — funds are not (re-)sent.
      expect(complete).not.toHaveBeenCalled();
    }
  );
});

// ─── #260 follow-up #3a: killed CONSUME → node-verified requeue ───────────────
// A deadline-killed guardian CONSUME reaches the guardian catch as an
// OperationAbortedError. Unlike send/swap/execute, a consume's input `noteId` is
// on the tx row, so before failing we ask the node whether the note landed as
// consumed: only 'landed-local' (a note consumed by THIS client's own tracked tx,
// provably mine) → Completed (the note WAS claimed). 'landed-external'
// (ConsumedExternal — consumed but NOT provably mine), 'not-landed', 'invalid', and
// 'unknown' → the unchanged funds-safe Failed. A false 'Received' is impossible —
// only a LOCAL consumed state completes the row.
describe('guardian killed CONSUME node-verify (#260 fu #3a)', () => {
  const consumeRow = { type: 'consume', noteId: '0xn1', noteIds: ['0xn1'] };

  it('node reports the note LOCAL-consumed (provably mine) → the killed consume ends Completed, not Failed, no requeue', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
    // The node confirms the input note is consumed on chain by this client's own tx
    // (the consume DID land before the offscreen realm was torn down).
    mockProxyGetInputNoteDetails.mockResolvedValue([{ state: 'ConsumedAuthenticatedLocal' }]);
    const { service } = arrange('kill-consume-landed', consumeRow);

    await generateTransaction(
      buildTx('kill-consume-landed', consumeRow) as never,
      signCallback,
      false,
      provider as never
    );

    // Dispatched once; the guardian candidate was still abandoned (idempotent).
    expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
    expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
    // Node-verified landed → Completed with the normal consume label, no requeue.
    const finalRow = txStore.find(r => r.id === 'kill-consume-landed')!;
    expect(finalRow.status).toBe(ITransactionStatus.Completed);
    expect(finalRow.status).not.toBe(ITransactionStatus.Queued);
    expect(finalRow.nextEligibleAt).toBeUndefined();
    expect(finalRow.displayMessage).toBe('Received');
    // The completion handler is NOT re-run — the killed op left no TransactionResult;
    // the row is marked Completed directly from the node verdict.
    expect(mockComplete.consume).not.toHaveBeenCalled();
  });

  it('node reports the note ConsumedExternal (NOT provably mine) → funds-safe Failed, never a false Received', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
    // ConsumedExternal = nullifier on chain but the consuming tx was not this
    // client's — e.g. a reclaimable P2IDE the sender reclaimed. Marking it Received
    // would misreport funds a third party took, so this path must fail it (funds-safe).
    mockProxyGetInputNoteDetails.mockResolvedValue([{ state: 'ConsumedExternal' }]);
    const { service } = arrange('kill-consume-external', consumeRow);

    await generateTransaction(
      buildTx('kill-consume-external', consumeRow) as never,
      signCallback,
      false,
      provider as never
    );

    expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
    const finalRow = txStore.find(r => r.id === 'kill-consume-external')!;
    expect(finalRow.status).toBe(ITransactionStatus.Failed);
    expect(finalRow.status).not.toBe(ITransactionStatus.Queued);
    expect(finalRow.displayMessage).not.toBe('Received');
    expect(mockComplete.consume).not.toHaveBeenCalled();
  });

  it('node still reports the note Committed → Failed, no requeue (consume did not land)', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
    mockProxyGetInputNoteDetails.mockResolvedValue([{ state: 'Committed' }]);
    const { service } = arrange('kill-consume-committed', consumeRow);

    await generateTransaction(
      buildTx('kill-consume-committed', consumeRow) as never,
      signCallback,
      false,
      provider as never
    );

    expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
    const finalRow = txStore.find(r => r.id === 'kill-consume-committed')!;
    expect(finalRow.status).toBe(ITransactionStatus.Failed);
    expect(finalRow.status).not.toBe(ITransactionStatus.Queued);
    expect(finalRow.nextEligibleAt).toBeUndefined();
    expect(mockComplete.consume).not.toHaveBeenCalled();
  });

  it('node query errors → Failed, never a false Completed', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
    mockProxyGetInputNoteDetails.mockRejectedValue(new Error('node unreachable'));
    const { service } = arrange('kill-consume-nodeerr', consumeRow);

    await generateTransaction(
      buildTx('kill-consume-nodeerr', consumeRow) as never,
      signCallback,
      false,
      provider as never
    );

    expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
    const finalRow = txStore.find(r => r.id === 'kill-consume-nodeerr')!;
    expect(finalRow.status).toBe(ITransactionStatus.Failed);
    expect(mockComplete.consume).not.toHaveBeenCalled();
  });

  it('a killed consume with no noteId cannot be node-verified → Failed, no node query', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
    // A consume identified only by `noteIds` (no singular `noteId`) has no id for
    // the node check, so verification is skipped and the row falls straight through
    // to the funds-safe Failed path.
    const noteIdsOnly = { type: 'consume', noteIds: ['0xn1'] };
    const { service } = arrange('kill-consume-noid', noteIdsOnly);

    await generateTransaction(
      buildTx('kill-consume-noid', noteIdsOnly) as never,
      signCallback,
      false,
      provider as never
    );

    expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
    expect(mockProxyGetInputNoteDetails).not.toHaveBeenCalled();
    const finalRow = txStore.find(r => r.id === 'kill-consume-noid')!;
    expect(finalRow.status).toBe(ITransactionStatus.Failed);
    expect(mockComplete.consume).not.toHaveBeenCalled();
  });
});

describe('guardian leaf errorCode preservation → guardian classifier marks Completed', () => {
  it.each(valueMovingCases())(
    '$type: a round-tripped ApplyTransactionAfterSubmitFailed marks the row Completed, not Failed',
    async ({ row, complete }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      const applyErr: Error & { errorCode?: string } = new Error('local apply failed after submit');
      applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
      mockDispatchGuardianPipeline.mockRejectedValue(applyErr);
      const { service } = arrange(`apply-${row.type}`, row);

      await generateTransaction(buildTx(`apply-${row.type}`, row) as never, signCallback, false, provider as never);

      // The GUARDIAN classifier (a DIFFERENT catch than the non-guardian loop's) read
      // the round-tripped code and marked Completed — the on-chain tx is live; the next
      // sync reconciles. NOT Failed → requeue → double-spend.
      const finalRow = txStore.find(r => r.id === `apply-${row.type}`)!;
      expect(finalRow.status).toBe(ITransactionStatus.Completed);
      // The submit-catch still abandoned the candidate (idempotent), and the value-moving
      // completion handler did NOT run (Completed was set directly by the classifier).
      expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();
    }
  );
});

// ─── Structural guardian types (issue #260, slice 6b) ────────────────────────
// switch-guardian / replace-hot-key / update-procedure-threshold route the SAME
// leaf offscreen as the value-moving types, but each carries SW-side side effects
// — cold co-sign, mid-flight persistNewHotKey, post-pipeline commit-wait — that
// must run in the SAME order (and only SW-side) on both flag states.

// One structural service carrying every proposal creator + the cold `signProposal`,
// the final `signAndCreateTransactionRequest`, and abandon. A single instance backs
// BOTH getOrCreateMultisigService (the switch-guardian hot service) and
// buildColdMultisigService (the cold co-sign / the cold-bound service that
// replace-hot-key + update-procedure-threshold build on), so a structural run has a
// single service object to assert on.
const makeStructuralService = () => ({
  createSwitchGuardianProposal: jest.fn(async () => ({ proposal: { id: 'prop', nonce: 7 } })),
  createReplaceHotKeyProposal: jest.fn(async () => ({
    proposal: { id: 'prop', nonce: 7 },
    newHot: { publicKeyHex: '0xNEWHOT', ciphertext: new Uint8Array([0xab, 0xcd]) }
  })),
  createUpdateProcedureThresholdProposal: jest.fn(async () => ({ id: 'prop', nonce: 7 })),
  signProposal: jest.fn(async () => {}),
  signAndCreateTransactionRequest: jest.fn(async () => ({
    serialize: () => new Uint8Array(TR_BYTES),
    authArg: () => undefined
  })),
  abandonCandidate: jest.fn(async () => {}),
  sync: jest.fn(async () => {})
});

// The guardian provider a structural run needs: it resolves a wallet account by
// publicKey (in-sync, so the sync guard is a no-op) and — for replace-hot-key —
// persists the freshly-minted hot key.
const makeStructuralProvider = () => ({
  getAccounts: async () => [{ publicKey: 'guardian-acc', guardianSyncStatus: 'in-sync' }],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig',
  persistNewHotKey: jest.fn(async () => {})
});

type StructuralCase = { type: string; row: Record<string, unknown>; complete: jest.Mock };
const structuralCases = (): StructuralCase[] => [
  {
    type: 'switch-guardian',
    row: { type: 'switch-guardian', extraInputs: { newGuardianEndpoint: 'https://guardian.new' } },
    complete: mockComplete.switchGuardian
  },
  {
    type: 'replace-hot-key',
    row: { type: 'replace-hot-key', extraInputs: {} },
    complete: mockComplete.replaceHotKey
  },
  {
    type: 'update-procedure-threshold',
    row: { type: 'update-procedure-threshold', extraInputs: { procedure: '0xproc', threshold: 2 } },
    complete: mockComplete.updateThreshold
  }
];

// All three structural completion handlers take `result` at arg index 1
// (switch-guardian: (tx, result, service, provider); replace-hot-key:
// (tx, result, provider); update-procedure-threshold: (tx, result, service)).
const STRUCTURAL_RESULT_ARG = 1;

/** Arrange a full structural guardian run: row, one shared service, inline client, provider. */
function arrangeStructural(id: string, extra: Record<string, unknown>, result = makeResult()) {
  const row = buildTx(id, extra);
  txStore.push({ ...row });
  const service = makeStructuralService();
  mockGetOrCreateMultisigService.mockResolvedValue(service);
  mockBuildColdMultisigService.mockResolvedValue(service);
  mockProxyGetAccount.mockResolvedValue({ id: () => ({ toString: () => 'sdk-acc' }) });
  const inline = makeInlineClient(result);
  mockGetMidenClient.mockResolvedValue(inline);
  mockIsGuardianAccount.mockResolvedValue(true);
  const structuralProvider = makeStructuralProvider();
  return { row, service, inline, provider: structuralProvider };
}

describe('structural guardian leaf routing — flag OFF (inline)', () => {
  it.each(structuralCases())(
    '$type: runs the inline pipeline, never dispatchGuardianPipeline; commit-wait routes through the proxy with the re-derived id',
    async ({ row, complete }) => {
      const { service, inline, provider: sp } = arrangeStructural(`s-off-${row.type}`, row);

      await generateTransaction(buildTx(`s-off-${row.type}`, row) as never, signCallback, false, sp as never);

      // The inline SW leaf ran once; the offscreen leaf was never touched.
      expect(inline.__executeRequest).toHaveBeenCalledTimes(1);
      expect(mockDispatchGuardianPipeline).not.toHaveBeenCalled();
      // Structural completion finalized with the inline result; abandon never ran.
      expect(complete).toHaveBeenCalledTimes(1);
      expect(service.abandonCandidate).not.toHaveBeenCalled();
      // The commit-wait goes through the PROXY (which, flag-off, runs the inline SW
      // client under its own lock — proven in miden-client-proxy.test.ts) with the id
      // re-derived from the result. The call site NEVER pokes the raw SW client
      // directly, so a future flag flip can't strand the wait on a dormant client.
      expect(mockProxyWaitForCommit).toHaveBeenCalledTimes(1);
      expect(mockProxyWaitForCommit).toHaveBeenCalledWith('exec-tx-hash');
      expect(inline.waitForTransactionCommit).not.toHaveBeenCalled();
      // The wait resolved BEFORE the structural completion ran.
      const waitOrder = mockProxyWaitForCommit.mock.invocationCallOrder[0]!;
      const completeOrder = complete.mock.invocationCallOrder[0]!;
      expect(waitOrder).toBeLessThan(completeOrder);
    }
  );
});

describe('structural guardian leaf routing — flag ON (offscreen)', () => {
  it.each(structuralCases())(
    '$type: crosses the co-signed request bytes to dispatchGuardianPipeline; commit-wait routes through the proxy (offscreen), never the dormant SW client',
    async ({ row, complete }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      const dispatched = makeResult();
      mockDispatchGuardianPipeline.mockResolvedValue(dispatched);
      const { inline, provider: sp } = arrangeStructural(`s-on-${row.type}`, row);

      await generateTransaction(buildTx(`s-on-${row.type}`, row) as never, signCallback, false, sp as never);

      // The inline SW leaf never executed; the offscreen leaf did, exactly once.
      expect(inline.__executeRequest).not.toHaveBeenCalled();
      expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
      const [acct, trBytes, delegate, cb] = mockDispatchGuardianPipeline.mock.calls[0];
      expect(acct).toBe('guardian-acc');
      // §4.0: the fully co-signed request (cold co-sign folded in for switch-guardian)
      // crossed as the EXACT serialized bytes.
      expect(Array.from(trBytes as Uint8Array)).toEqual(TR_BYTES);
      expect(delegate).toBe(false);
      expect(cb).toBe(signCallback);
      // THE FIX (issue #260, slice 6b): the commit-wait routes through the proxy —
      // which flag-on forwards to the OFFSCREEN realm that applied the tx (proven in
      // miden-client-proxy.test.ts) — with the id re-derived from the round-tripped
      // result. It must NEVER poll the raw SW `getMidenClient().waitForTransactionCommit`:
      // flag-on that client is dormant/unsynced, so a raw wait would time out at ~60s,
      // fall through to Failed, and SKIP the structural completion (e.g. leaving
      // replace-hot-key's chain rotation done but the local hot-key pointer stale).
      expect(mockProxyWaitForCommit).toHaveBeenCalledTimes(1);
      expect(mockProxyWaitForCommit).toHaveBeenCalledWith('exec-tx-hash');
      expect(inline.waitForTransactionCommit).not.toHaveBeenCalled();
      // The wait resolved BEFORE the structural completion ran.
      const waitOrder = mockProxyWaitForCommit.mock.invocationCallOrder[0]!;
      const completeOrder = complete.mock.invocationCallOrder[0]!;
      expect(waitOrder).toBeLessThan(completeOrder);
      // Structural completion finalized with the round-tripped result.
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0][STRUCTURAL_RESULT_ARG]).toBe(dispatched);
    }
  );
});

describe('structural guardian leaf byte-identity — flag ON result bytes == flag OFF result bytes', () => {
  it.each(structuralCases())(
    '$type: completion handler receives identical serialize() bytes on both paths',
    async ({ row, complete }) => {
      // Flag OFF: inline leaf returns a result serializing to [7,7,7].
      const { provider: spOff } = arrangeStructural(`sbi-off-${row.type}`, row, makeResult([7, 7, 7]));
      await generateTransaction(buildTx(`sbi-off-${row.type}`, row) as never, signCallback, false, spOff as never);
      const offResult = complete.mock.calls[0][STRUCTURAL_RESULT_ARG] as ReturnType<typeof makeResult>;

      // Flag ON: the offscreen leaf returns a result serializing to the SAME [7,7,7].
      jest.clearAllMocks();
      txStore.length = 0;
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      mockDispatchGuardianPipeline.mockResolvedValue(makeResult([7, 7, 7]));
      const { provider: spOn } = arrangeStructural(`sbi-on-${row.type}`, row, makeResult([7, 7, 7]));
      await generateTransaction(buildTx(`sbi-on-${row.type}`, row) as never, signCallback, false, spOn as never);
      const onResult = complete.mock.calls[0][STRUCTURAL_RESULT_ARG] as ReturnType<typeof makeResult>;

      expect(Array.from(offResult.serialize())).toEqual(Array.from(onResult.serialize()));
      expect(Array.from(onResult.serialize())).toEqual([7, 7, 7]);
    }
  );
});

describe('structural persistNewHotKey ordering parity — SW-side, once, before the leaf, both flags', () => {
  it.each([
    { flag: 'off', on: false },
    { flag: 'on', on: true }
  ])('replace-hot-key persists the new hot key before the leaf (flag $flag)', async ({ on }) => {
    if (on) {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      mockDispatchGuardianPipeline.mockResolvedValue(makeResult());
    }
    const row = { type: 'replace-hot-key', extraInputs: {} };
    const { service, inline, provider: sp } = arrangeStructural(`persist-${on}`, row);

    await generateTransaction(buildTx(`persist-${on}`, row) as never, signCallback, false, sp as never);

    // Persisted exactly once, with the freshly-minted key material, on BOTH flags.
    expect(sp.persistNewHotKey).toHaveBeenCalledTimes(1);
    expect(sp.persistNewHotKey).toHaveBeenCalledWith('0xNEWHOT', new Uint8Array([0xab, 0xcd]));

    // Ordering: persist ran BEFORE signAndCreateTransactionRequest, which ran BEFORE the
    // leaf — the SAME relative order flag-on vs flag-off. The offscreen move does not
    // change when persistNewHotKey runs relative to submit, so a kill can never desync
    // the local hot key from chain differently than flag-off does today.
    const persistOrder = sp.persistNewHotKey.mock.invocationCallOrder[0]!;
    const signOrder = service.signAndCreateTransactionRequest.mock.invocationCallOrder[0]!;
    expect(persistOrder).toBeLessThan(signOrder);
    const leafOrder = (
      on
        ? mockDispatchGuardianPipeline.mock.invocationCallOrder[0]
        : inline.__executeRequest.mock.invocationCallOrder[0]
    )!;
    expect(signOrder).toBeLessThan(leafOrder);
  });
});

describe('structural guardian leaf kill-window (funds-safety) — an offscreen kill FAILS the row, no auto-requeue', () => {
  it.each(structuralCases())(
    '$type: an OperationAbortedError marks the row Failed, abandons once, dispatches once, never requeues',
    async ({ row, complete }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      // A deadline/`closeDocument` wedge-kill → retryable OperationAbortedError. A
      // structural op is nonce-gated and EXCLUDED from REQUEUEABLE_TYPES, so a killed row
      // is terminally Failed (never auto-requeued): the only recovery is a user re-run
      // that builds a FRESH proposal against the post-change chain state, which — because
      // a landed structural change advanced the nonce and changed guardian state — is a
      // no-op/rejected against that new state, never a double-apply. Same terminal-Failed
      // model as slice 6a and guardian flag-OFF.
      mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
      const { service, provider: sp } = arrangeStructural(`s-kill-${row.type}`, row);

      await generateTransaction(buildTx(`s-kill-${row.type}`, row) as never, signCallback, false, sp as never);

      // Dispatched exactly ONCE — the abort did NOT trigger a second offscreen submit.
      expect(mockDispatchGuardianPipeline).toHaveBeenCalledTimes(1);
      // The SW submit-catch abandoned the guardian candidate (idempotent), exactly once.
      expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
      expect(service.abandonCandidate).toHaveBeenCalledWith(7);
      // The row is terminally FAILED — NOT requeued, and carries no requeue cooldown stamp.
      const finalRow = txStore.find(r => r.id === `s-kill-${row.type}`)!;
      expect(finalRow.status).toBe(ITransactionStatus.Failed);
      expect(finalRow.status).not.toBe(ITransactionStatus.Queued);
      expect(finalRow.nextEligibleAt).toBeUndefined();
      // No structural completion ran — the change is not (re-)applied locally.
      expect(complete).not.toHaveBeenCalled();
    }
  );
});

describe('structural guardian leaf errorCode preservation → guardian classifier routes per type', () => {
  it.each([
    {
      type: 'replace-hot-key',
      row: { type: 'replace-hot-key', extraInputs: {} },
      complete: mockComplete.replaceHotKey
    },
    {
      type: 'switch-guardian',
      row: { type: 'switch-guardian', extraInputs: { newGuardianEndpoint: 'https://guardian.new' } },
      complete: mockComplete.switchGuardian
    }
  ])(
    '$type: a round-tripped ApplyTransactionAfterSubmitFailed reaches the RECONCILE handler (row not Failed)',
    async ({ type, row, complete }) => {
      process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
      const applyErr: Error & { errorCode?: string } = new Error('local apply failed after submit');
      applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
      mockDispatchGuardianPipeline.mockRejectedValue(applyErr);
      const { service, provider: sp } = arrangeStructural(`s-apply-${type}`, row);

      await generateTransaction(buildTx(`s-apply-${type}`, row) as never, signCallback, false, sp as never);

      // The GUARDIAN classifier read the round-tripped errorCode and routed the structural
      // op to reconcileStructuralApplyFailure — the change IS on chain, so the completion
      // handler runs (with an UNDEFINED result) to finalize the vault / guardian state
      // rather than cancelling. This proves the errorCode survived the offscreen round-trip
      // and reached the guardian classifier.
      expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]![STRUCTURAL_RESULT_ARG]).toBeUndefined();
      const finalRow = txStore.find(r => r.id === `s-apply-${type}`)!;
      expect(finalRow.status).not.toBe(ITransactionStatus.Failed);
    }
  );

  it('update-procedure-threshold: a round-tripped ApplyTransactionAfterSubmitFailed reaches the classifier → Failed', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    const applyErr: Error & { errorCode?: string } = new Error('local apply failed after submit');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
    mockDispatchGuardianPipeline.mockRejectedValue(applyErr);
    const row = { type: 'update-procedure-threshold', extraInputs: { procedure: '0xproc', threshold: 2 } };
    const { service, provider: sp } = arrangeStructural('s-apply-upt', row);

    await generateTransaction(buildTx('s-apply-upt', row) as never, signCallback, false, sp as never);

    // update-procedure-threshold has NO reconcile handler (unlike replace-hot-key /
    // switch-guardian): the classifier routes its post-submit apply failure straight to
    // cancelTransaction → Failed — byte-identical to flag-OFF (the same inline apply throw
    // classifies the same way). The errorCode still reached the classifier; the
    // type-appropriate outcome is Failed, and the completion handler does not run.
    expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
    expect(mockComplete.updateThreshold).not.toHaveBeenCalled();
    const finalRow = txStore.find(r => r.id === 's-apply-upt')!;
    expect(finalRow.status).toBe(ITransactionStatus.Failed);
  });
});
