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

jest.mock('lib/miden/repo', () => ({
  db: { transaction: async (_mode: string, _t: unknown, cb: () => unknown) => cb() },
  transactions: {
    add: jest.fn(async (tx: Record<string, unknown>) => {
      txStore.push({ ...tx });
    }),
    where: jest.fn((query: { id: string }) => ({
      modify: jest.fn(async (fn: (tx: Record<string, unknown>) => void) => {
        const row = txStore.find(r => r.id === query.id);
        if (row) fn(row);
        if (mockThrowOnStageWrite !== null && row?.stage === mockThrowOnStageWrite) {
          throw new Error(`dexie write blew up stamping '${mockThrowOnStageWrite}'`);
        }
      }),
      first: jest.fn(async () => txStore.find(r => r.id === query.id))
    })),
    filter: jest.fn(() => ({ toArray: jest.fn(async () => []) }))
  }
}));

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
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => mockPlatformIsMobile
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
  mockThrowOnStageWrite = null;
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
