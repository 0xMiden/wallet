/**
 * Non-guardian `send` → the per-step stage stamp is handed to the proxy
 * UNCONDITIONALLY, whatever the ambient offscreen flag says (PR #524 × issue #260).
 *
 * PR #524 made the send drive execute → prove → submit as distinct stages and
 * threaded a stage callback into the SDK call; those stamps land in
 * `stageTimestamps` on the row and are what the generating-transaction screen turns
 * into a duration per step. Issue #260 then replaced the inline call with
 * `midenClientProxy.sendTransaction`, which flag-ON runs the WHOLE
 * execute→prove→submit→apply op inside the offscreen document.
 *
 * The regression this file pins: for a while the stage callback rode the INLINE
 * (flag-OFF) leaf only. `vite.background.config.ts` defaults
 * MIDEN_USE_OFFSCREEN_CLIENT to `'true'` and the transaction loop runs in the
 * extension's service worker, so on Chrome — the primary platform — that silently
 * deleted the per-step timings.
 *
 * What the flag does and does NOT mean here. `case 'send'` in `./index` deliberately
 * does not read the flag at all — the proxy owns that routing (straight through to
 * the inline `sendTransaction(tx, onStage)` flag-OFF, op-scoped + replayed from
 * OFFSCREEN_STAGE_EVENTs flag-ON; both proven in `miden-client-proxy.test.ts`, which
 * loads the proxy for real under each flag). So the two tests below run the same
 * delegation code, and that INVARIANCE is exactly the property under test: a
 * flag-conditional callback here is the shape the regression took, and only the
 * flag-ON case would catch it (the flag is read per call in `./index`, so an
 * env-var toggle is live). The header claims nothing more than that.
 *
 * Scope: the DELEGATION seam only. The proxy is a spy here.
 */

import { generateTransaction } from './index';
import { ITransactionStatus } from '../db/types';

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

// Non-guardian throughout: the standard signCallback dispatch path.
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: jest.fn(async () => false),
  getOrCreateMultisigService: jest.fn(),
  clearGuardianServiceFor: jest.fn()
}));

jest.mock('lib/miden/guardian', () => ({
  MultisigService: { buildColdMultisigService: jest.fn() }
}));

// The inline SW client leaf. After #260 nothing on the non-guardian send path may
// reach it directly — the proxy owns that branch — so its spy must stay untouched.
const mockInlineSendTransaction = jest.fn(async () => makeResult());
const mockGetMidenClient = jest.fn(async () => ({ sendTransaction: mockInlineSendTransaction }));
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  getMidenClient: (...a: unknown[]) => mockGetMidenClient(...(a as []))
}));

// The routing seam under test: the proxy's send leaf is a controllable spy that
// also EXERCISES the stage callback it is handed, so we can assert the stamps
// actually reach `setTransactionStage` (not merely that a function was passed).
const mockProxySendTransaction = jest.fn(async (..._a: unknown[]) => makeResult());
jest.mock('../back/miden-client-proxy', () => ({
  dispatchGuardianPipeline: jest.fn(),
  midenClientProxy: {
    syncState: jest.fn(async () => {}),
    getAccount: jest.fn(async () => null),
    waitForTransactionCommit: jest.fn(async () => {}),
    consumeNoteId: jest.fn(async () => makeResult()),
    swapTransaction: jest.fn(async () => makeResult()),
    newTransaction: jest.fn(async () => makeResult()),
    sendTransaction: (...a: unknown[]) => mockProxySendTransaction(...a)
  }
}));

// The stage stamps the callback writes; `setTransactionStage` is the real seam the
// generating-transaction screen reads through `stageTimestamps`. When
// `mockThrowOnStage` names a stage, that one row write REJECTS — the Dexie hiccup a
// stamp must survive.
const stamped: string[] = [];
// eslint-disable-next-line no-var
var mockThrowOnStage: string | null = null;
jest.mock('./helper', () => {
  const actual = jest.requireActual('./helper');
  return {
    ...actual,
    setTransactionStage: jest.fn(async (id: string, stage: string) => {
      if (mockThrowOnStage === stage) throw new Error(`dexie write blew up stamping '${stage}'`);
      stamped.push(`${id}:${stage}`);
    })
  };
});

// Offscreen API present, so the FLAG alone decides the route (inside the proxy).
jest.mock('../back/offscreen-prover', () => ({ isOffscreenAvailable: () => true }));

jest.mock('./complete', () => ({
  completeSendTransaction: jest.fn(async () => {}),
  completeConsumeTransaction: jest.fn(async () => {}),
  completeSwapTransaction: jest.fn(async () => {}),
  completeCustomTransaction: jest.fn(async () => {}),
  completeBridgedSendTransaction: jest.fn(async () => {}),
  completeEarnDepositTransaction: jest.fn(async () => {}),
  completeSwitchGuardianTransaction: jest.fn(async () => {}),
  completeReplaceHotKeyTransaction: jest.fn(async () => {}),
  completeUpdateProcedureThresholdTransaction: jest.fn(async () => {})
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    TransactionProver: {
      newLocalProver: jest.fn(() => 'local-prover'),
      newCallbackProver: jest.fn(() => 'callback-prover')
    },
    WasmWebClient: { createClient: jest.fn() }
  };
});

jest.mock('../sdk/native-prover-mobile', () => ({
  buildNativeProverCallback: jest.fn(() => async () => new Uint8Array())
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => false
}));

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn(), info: jest.fn() }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  canonicalWalletAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a === b
}));

jest.mock('lib/intercom', () => ({ getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() }) }));
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));

/** A TransactionResult-like whose serialize() + executedTransaction() are stable. */
function makeResult() {
  return {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'exec-tx-hash' }),
      outputNotes: () => ({ notes: () => [] }),
      inputNotes: () => ({ notes: () => [] })
    }),
    serialize: () => new Uint8Array([7, 7, 7])
  };
}

const signCallback = jest.fn(async () => new Uint8Array([2]));
const provider = {
  getAccounts: async () => [] as unknown[],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig'
};

async function runSend(id: string) {
  const tx = {
    id,
    type: 'send',
    accountId: 'acc-1',
    secondaryAccountId: 'mtst1qrecipient',
    faucetId: 'faucet',
    amount: 1000n,
    noteType: 'public',
    status: ITransactionStatus.Queued,
    displayMessage: 'Queued',
    displayIcon: 'SEND',
    delegateTransaction: false,
    initiatedAt: Math.floor(Date.now() / 1000)
  };
  txStore.push({ ...tx });
  await generateTransaction(tx as never, signCallback, false, provider as never);
  return tx;
}

/** Invoke the stage callback the switch handed the proxy, as the staged pipeline
 * does, and report the stamps IT produced. The loop writes its own coarse stages
 * around the write (`syncing`, …), so the log is cleared first to isolate the
 * callback's contribution. */
async function driveStages(): Promise<string[]> {
  stamped.length = 0;
  const onStage = mockProxySendTransaction.mock.calls[0]![2] as (s: string) => Promise<void>;
  for (const stage of ['executing', 'proving', 'submitting']) {
    // eslint-disable-next-line no-await-in-loop
    await onStage(stage);
  }
  return stamped;
}

beforeEach(() => {
  jest.clearAllMocks();
  txStore.length = 0;
  stamped.length = 0;
  mockThrowOnStage = null;
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

afterEach(() => {
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
});

describe('non-guardian send → the stage callback reaches the proxy whatever the offscreen flag says (PR #524 × #260)', () => {
  it('flag OFF → one proxy call carrying (tx, signCallback, onStage); the stamps land on THIS row', async () => {
    const tx = await runSend('tx-send-flagoff');

    expect(mockProxySendTransaction).toHaveBeenCalledTimes(1);
    const [sentTx, sentSign, onStage] = mockProxySendTransaction.mock.calls[0]!;
    expect(sentTx).toBe(tx);
    expect(sentSign).toBe(signCallback);
    expect(typeof onStage).toBe('function');
    // The callback is row-bound: every stamp it makes is keyed by this tx's id.
    expect(await driveStages()).toEqual([
      'tx-send-flagoff:executing',
      'tx-send-flagoff:proving',
      'tx-send-flagoff:submitting'
    ]);
    // The switch never forks to an inline leaf of its own.
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockInlineSendTransaction).not.toHaveBeenCalled();
  });

  it('the delegation is IDENTICAL with MIDEN_USE_OFFSCREEN_CLIENT=true — the switch must not branch on the flag', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    const tx = await runSend('tx-send-flagon');

    // Flag ON is the ambient state of the SW build, and the switch must be blind to
    // it: exactly ONE proxy call, with the SAME three arguments the flag-OFF case
    // asserted, and no second flag-conditional branch anywhere near it.
    expect(mockProxySendTransaction).toHaveBeenCalledTimes(1);
    expect(mockProxySendTransaction.mock.calls[0]!).toHaveLength(3);
    const [sentTx, sentSign, onStage] = mockProxySendTransaction.mock.calls[0]!;
    expect(sentTx).toBe(tx);
    expect(sentSign).toBe(signCallback);
    // The load-bearing assertion: a third argument EXISTS flag-ON. Without it the
    // per-step timings vanish on Chrome, silently.
    expect(typeof onStage).toBe('function');
    expect(await driveStages()).toEqual([
      'tx-send-flagon:executing',
      'tx-send-flagon:proving',
      'tx-send-flagon:submitting'
    ]);
    expect(mockGetMidenClient).not.toHaveBeenCalled();
  });

  it('flag OFF: a stamp whose row write REJECTS never fails the write — the inline SDK AWAITS this callback', async () => {
    // Flag-OFF the proxy hands this exact callback to
    // `MidenClientInterface.sendTransaction`, which does `await onStage?.('proving')`
    // between execute and prove. Model that faithfully: the leaf awaits each stamp,
    // so an unguarded rejection would propagate out of the send and Fail the row.
    mockThrowOnStage = 'proving';
    mockProxySendTransaction.mockImplementationOnce(async (..._a: unknown[]) => {
      const onStage = _a[2] as (s: string) => Promise<void>;
      await onStage('executing');
      await onStage('proving');
      await onStage('submitting');
      return makeResult();
    });

    await runSend('tx-send-throwing-stamp');

    // The write ran past the failed stamp to `submitting` and finished; the row is
    // not Failed. Only the one stamp is missing — a blank duration, never a
    // transaction.
    expect(stamped).toContain('tx-send-throwing-stamp:executing');
    expect(stamped).toContain('tx-send-throwing-stamp:submitting');
    expect(stamped).not.toContain('tx-send-throwing-stamp:proving');
    expect(txStore.find(r => r.id === 'tx-send-throwing-stamp')!.status).not.toBe(ITransactionStatus.Failed);
  });
});
