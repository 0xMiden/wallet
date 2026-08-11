/**
 * Guardian write LEAF PIPELINE → offscreen routing (issue #260, slice 6a).
 *
 * These tests exercise `generateTransaction` at the routing seam: with the
 * offscreen client flag OFF the value-moving guardian leaf runs inline
 * (`runGuardianPipeline` → the mocked SW client's execute→prove→submit→apply);
 * with it ON the SAME leaf crosses to `dispatchGuardianPipeline`. Everything
 * around the leaf — proposal creation, `signAndCreateTransactionRequest`, the
 * `abandonCandidate` submit-catch, the value-moving apply-after-submit classifier
 * — stays SW-side and is asserted unchanged.
 *
 * Coverage:
 *   - §4.0 round-trip: the co-signed request crosses to the offscreen leaf as the
 *     EXACT `tr.serialize()` bytes (advice map — carrying the co-signatures —
 *     intact; the byte-level serialize→transport→deserialize→execute round-trip is
 *     proven in miden-client-proxy.test.ts + offscreen/main.test.ts).
 *   - flag routing OFF/ON per value-moving type; structural / bridged stay inline
 *     even with the flag ON.
 *   - flag-off/flag-on byte-identity: the completion handler receives a result with
 *     identical `serialize()` bytes on both paths.
 *   - kill-window: an offscreen `OperationAbortedError` runs `abandonCandidate`
 *     exactly once (as inline) and DEFERS the row to Queued (not Failed); a
 *     value-already-moved retry marks Completed via the nullifier backstop, never
 *     re-sends.
 *   - errorCode: a round-tripped `ApplyTransactionAfterSubmitFailed` reaches the
 *     GUARDIAN classifier → marks Completed (mirrors the fixed non-guardian bug).
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

jest.mock('lib/miden/guardian', () => ({
  MultisigService: { buildColdMultisigService: jest.fn() }
}));

const mockWithWasmClientLock = jest.fn(async (fn: () => Promise<unknown>) => fn());
const mockGetMidenClient = jest.fn();
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: (...a: unknown[]) => mockWithWasmClientLock(...(a as [() => Promise<unknown>])),
  getMidenClient: (...a: unknown[]) => mockGetMidenClient(...a)
}));

// The routing seam under test: `dispatchGuardianPipeline` is a controllable spy,
// and `midenClientProxy.syncState` is the pre-guardian sync (no-op here).
const mockDispatchGuardianPipeline = jest.fn();
jest.mock('../back/miden-client-proxy', () => ({
  dispatchGuardianPipeline: (...a: unknown[]) => mockDispatchGuardianPipeline(...a),
  midenClientProxy: {
    syncState: jest.fn(async () => {}),
    getAccount: jest.fn(async () => null)
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
});

describe('guardian leaf routing — not-yet-sliced types stay inline even with the flag ON', () => {
  it('bridged-send (agglayer) runs the inline leaf, never dispatchGuardianPipeline', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    const { inline } = arrange('on-bridged', {
      type: 'bridged-send',
      secondaryAccountId: 'r',
      faucetId: 'f',
      amount: '3',
      requestBytes: new Uint8Array([3, 3]),
      extraInputs: { provider: 'agglayer' }
    });

    await generateTransaction(
      buildTx('on-bridged', {
        type: 'bridged-send',
        secondaryAccountId: 'r',
        faucetId: 'f',
        amount: '3',
        requestBytes: new Uint8Array([3, 3]),
        extraInputs: { provider: 'agglayer' }
      }) as never,
      signCallback,
      false,
      provider as never
    );

    expect(inline.__executeRequest).toHaveBeenCalledTimes(1);
    expect(mockDispatchGuardianPipeline).not.toHaveBeenCalled();
    expect(mockComplete.bridged).toHaveBeenCalledTimes(1);
  });
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

describe('guardian leaf kill-window (funds-safety)', () => {
  it('a pre-submit offscreen kill runs abandonCandidate exactly once and DEFERS the row to Queued (not Failed)', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    // Deadline/closeDocument kill before submit → retryable OperationAbortedError.
    mockDispatchGuardianPipeline.mockRejectedValue(new OperationAbortedError('op-1', 'deadline'));
    const { service } = arrange('kill-consume', { type: 'consume', noteId: '0xn', noteIds: ['0xn'] });

    await generateTransaction(
      buildTx('kill-consume', { type: 'consume', noteId: '0xn', noteIds: ['0xn'] }) as never,
      signCallback,
      false,
      provider as never
    );

    // The SW submit-catch abandoned the guardian candidate, exactly once (as inline).
    expect(service.abandonCandidate).toHaveBeenCalledTimes(1);
    expect(service.abandonCandidate).toHaveBeenCalledWith(7);
    // The row was DEFERRED to Queued — a transient wedge-kill must NOT terminally Fail.
    const finalRow = txStore.find(r => r.id === 'kill-consume')!;
    expect(finalRow.status).toBe(ITransactionStatus.Queued);
    expect(finalRow.nextEligibleAt).toBeDefined();
    // The note was NOT claimed (nothing on chain) — completion never ran.
    expect(mockComplete.consume).not.toHaveBeenCalled();
  });

  it('co-signed nullifier backstop: after a submit-landed kill + requeue, the retry marks Completed (not re-sent)', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';

    // Cycle 1 — killed mid/after submit; the value MAY have landed. Requeued.
    mockDispatchGuardianPipeline.mockRejectedValueOnce(new OperationAbortedError('op-a', 'deadline'));
    const { service } = arrange('backstop-send', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' });
    await generateTransaction(
      buildTx('backstop-send', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' }) as never,
      signCallback,
      false,
      provider as never
    );
    expect(txStore.find(r => r.id === 'backstop-send')!.status).toBe(ITransactionStatus.Queued);

    // Cycle 2 — the retry re-submits; the on-chain consumed-nullifier rejects the
    // double-spend, surfacing as ApplyTransactionAfterSubmitFailed. The GUARDIAN
    // classifier marks Completed (value already moved) — NEVER a second send.
    const applyErr: Error & { errorCode?: string } = new Error('local apply failed after submit');
    applyErr.errorCode = 'ApplyTransactionAfterSubmitFailed';
    mockDispatchGuardianPipeline.mockRejectedValueOnce(applyErr);
    // Re-arm the row to GeneratingTransaction the way the loop would on re-pickup.
    const row = txStore.find(r => r.id === 'backstop-send')!;
    row.status = ITransactionStatus.GeneratingTransaction;
    await generateTransaction(
      buildTx('backstop-send', { type: 'send', secondaryAccountId: 'r', faucetId: 'f', amount: '1' }) as never,
      signCallback,
      false,
      provider as never
    );

    expect(txStore.find(r => r.id === 'backstop-send')!.status).toBe(ITransactionStatus.Completed);
    // No second value-moving completion — the funds are not re-sent.
    expect(mockComplete.send).not.toHaveBeenCalled();
    // abandonCandidate ran once per cycle (idempotent), never double-submitted funds.
    expect(service.abandonCandidate).toHaveBeenCalledTimes(2);
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
