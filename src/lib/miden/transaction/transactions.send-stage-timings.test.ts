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
 * Scope: the DELEGATION seam only. The proxy is a spy here. The last describe
 * reuses this harness for #1202: it holds the send open, so the row keeps the
 * GeneratingTransaction stamp the real writer gave it while the cold-start sweep runs,
 * and in one test holds the stamp write itself open, to pin that the writer marks the
 * row as this realm's before that write.
 */

import * as Repo from 'lib/miden/repo';

import { failInterruptedTransactions, MAX_WAIT_BEFORE_CANCEL, SESSION_STARTED_AT } from './cancel';
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

jest.mock('lib/settings/constants', () => ({}));

// Non-guardian throughout: the standard signCallback dispatch path.
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: jest.fn(async () => false),
  getOrCreateMultisigService: jest.fn(),
  clearGuardianServiceFor: jest.fn()
}));

jest.mock('lib/miden/guardian', () => {
  const actual = jest.requireActual<typeof import('lib/miden/guardian')>('lib/miden/guardian');
  return {
    GUARDIAN_CANDIDATE_HOLD_MS: actual.GUARDIAN_CANDIDATE_HOLD_MS,
    PRIOR_CANDIDATE_CHECK_TIMEOUT_MS: actual.PRIOR_CANDIDATE_CHECK_TIMEOUT_MS,
    MultisigService: { buildColdMultisigService: jest.fn() }
  };
});

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

describe('attempts (#1081)', () => {
  it('stamps a fresh attemptId at pickup and records the crossing under it, with its evidence', async () => {
    await runSend('tx-attempt');
    const row = txStore.find(r => r.id === 'tx-attempt');
    expect(typeof row?.attemptId).toBe('string');
    const onStage = mockProxySendTransaction.mock.calls[0]![2] as (s: string, d?: unknown) => Promise<void>;
    const id = `0x${'a'.repeat(64)}`;
    await onStage('submitting', { reliable: false, evidence: { transactionId: id } });
    expect(row?.mayHaveSubmitted).toBe(true);
    expect(row?.submitEvidence).toEqual([
      expect.objectContaining({ attemptId: row?.attemptId, source: 'stage', transactionId: id })
    ]);
  });

  it('gives every run its own attemptId', async () => {
    await runSend('tx-one');
    await runSend('tx-two');
    const ids = txStore.map(r => r.attemptId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('an attempt that may have crossed is never invisible (#1081)', () => {
  const entriesOf = (id: string) => txStore.find(r => r.id === id)?.submitEvidence ?? [];

  it('offscreen: an untagged leaf failure leaves an evidence-less end entry', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    mockProxySendTransaction.mockRejectedValueOnce(new Error('sendTransaction: result decode failed'));
    await expect(runSend('tx-end')).rejects.toThrow('result decode failed');
    expect(entriesOf('tx-end')).toEqual([expect.objectContaining({ source: 'end' })]);
  });

  it('offscreen: an untagged execute failure leaves an end entry marked as an execute', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    proxyMock().newTransaction.mockRejectedValueOnce(new Error('newTransaction: result decode failed'));
    await expect(runRow({ id: 'tx-exec-end', type: 'execute', requestBytes: new Uint8Array([1]) })).rejects.toThrow(
      'result decode failed'
    );
    expect(entriesOf('tx-exec-end')).toEqual([expect.objectContaining({ source: 'end', fromExecute: true })]);
  });

  it('offscreen: a tagged failure leaves none', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    const { markErrorBeforeSubmit } = jest.requireActual('../sdk/sdk-error-code');
    mockProxySendTransaction.mockRejectedValueOnce(markErrorBeforeSubmit(new Error('vault slot missing')));
    await expect(runSend('tx-pre')).rejects.toThrow('vault slot missing');
    expect(entriesOf('tx-pre')).toEqual([]);
  });

  it('in realm: a stamp-free failure leaves none', async () => {
    mockProxySendTransaction.mockRejectedValueOnce(new Error('prover exploded'));
    await expect(runSend('tx-inline')).rejects.toThrow('prover exploded');
    expect(entriesOf('tx-inline')).toEqual([]);
  });

  it('a kill or the indefinite outcome is left to its own route', async () => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
    const { WasmClientPoisonedError } = jest.requireActual('../sdk/wasm-client-poison');
    mockProxySendTransaction.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog', new Error('x')));
    await expect(runSend('tx-kill')).rejects.toThrow();
    mockProxySendTransaction.mockRejectedValueOnce(
      new Error(`submission of transaction 0x${'a'.repeat(64)} came back without a definite outcome`)
    );
    await expect(runSend('tx-unknown')).rejects.toThrow();
    expect(entriesOf('tx-kill')).toEqual([]);
    expect(entriesOf('tx-unknown')).toEqual([]);
  });
});

async function runRow(row: Record<string, unknown>) {
  const tx = {
    status: ITransactionStatus.Queued,
    displayMessage: 'Queued',
    displayIcon: 'DEFAULT',
    delegateTransaction: false,
    initiatedAt: Math.floor(Date.now() / 1000),
    accountId: 'acc-1',
    ...row
  };
  txStore.push({ ...tx });
  await generateTransaction(tx as never, signCallback, false, provider as never);
}

const proxyMock = () => jest.requireMock('../back/miden-client-proxy').midenClientProxy;

describe('which dispatches carry a stamp (#1081)', () => {
  it.each<[string, Record<string, unknown>, 'consumeNoteId' | 'swapTransaction' | 'newTransaction', number, boolean]>([
    ['a claim', { id: 'c', type: 'consume', noteId: 'n', noteIds: ['n'] }, 'consumeNoteId', 2, true],
    [
      'a rotation-funding claim',
      { id: 'cf', type: 'consume', noteId: 'n', noteIds: ['n'], rotationFunding: true },
      'consumeNoteId',
      2,
      false
    ],
    [
      'a swap',
      {
        id: 's',
        type: 'swap',
        faucetId: 'f',
        amount: 1n,
        extraInputs: { requestedFaucetId: 'g', requestedAmount: 2n }
      },
      'swapTransaction',
      2,
      true
    ],
    ['a dApp execute', { id: 'e', type: 'execute', requestBytes: new Uint8Array([1]) }, 'newTransaction', 4, true],
    [
      'an Agglayer bridge',
      { id: 'b', type: 'bridged-send', requestBytes: new Uint8Array([1]), extraInputs: { provider: 'agglayer' } },
      'newTransaction',
      4,
      true
    ],
    [
      'an Epoch bridge',
      { id: 'p', type: 'bridged-send', requestBytes: new Uint8Array([1]), extraInputs: { provider: 'epoch' } },
      'newTransaction',
      4,
      false
    ]
  ])('%s', async (_label, row, leaf, stampIndex, stamped) => {
    await runRow(row);
    const call = proxyMock()[leaf].mock.calls[0];
    expect(typeof call[stampIndex] === 'function').toBe(stamped);
  });
});

describe('the cold-start sweep against a row the real writer moved to GeneratingTransaction (#1202)', () => {
  /** Holds the next proxy send open until `release`, which is safe to call before the send gets there. */
  function holdNextProxySend() {
    let markReached!: () => void;
    const reached = new Promise<void>(resolve => (markReached = resolve));
    let release!: () => void;
    const released = new Promise<void>(resolve => (release = resolve));
    mockProxySendTransaction.mockImplementationOnce(async () => {
      markReached();
      await released;
      return makeResult();
    });
    return { reached, release };
  }

  it('spares the row this session is sending and fails an orphan stamped before the session, in one sweep', async () => {
    const send = holdNextProxySend();
    const sending = runSend('tx-live');
    try {
      await Promise.race([
        send.reached,
        sending.then(() => {
          throw new Error('send settled before reaching the proxy');
        })
      ]);
      const reachedAt = Math.floor(Date.now() / 1000);

      const live = txStore.find(r => r.id === 'tx-live')!;
      expect(live.status).toBe(ITransactionStatus.GeneratingTransaction);
      expect(Number.isInteger(live.processingStartedAt)).toBe(true);
      // Both bounds pin the unit: a milliseconds stamp clears the lower one and would spare every earlier row.
      expect(live.processingStartedAt).toBeGreaterThanOrEqual(SESSION_STARTED_AT);
      expect(live.processingStartedAt).toBeLessThanOrEqual(reachedAt);

      txStore.push({
        id: 'tx-orphan',
        type: 'send',
        accountId: 'acc-1',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: SESSION_STARTED_AT - 10,
        processingStartedAt: SESSION_STARTED_AT - 1
      });
      jest
        .mocked(Repo.transactions.filter)
        .mockImplementationOnce(pred => ({ toArray: async () => txStore.filter(row => pred(row as never)) }) as never);
      const liveBefore = { ...live };

      await failInterruptedTransactions();

      expect(live).toEqual(liveBefore);
      expect(txStore.find(r => r.id === 'tx-orphan')!.status).toBe(ITransactionStatus.Failed);
    } finally {
      send.release();
    }
    await sending;
  });

  it('spares the row this realm is sending even when the clock stepped back before its stamp', async () => {
    const send = holdNextProxySend();
    const clockStepped = jest.spyOn(Date, 'now').mockReturnValue((SESSION_STARTED_AT - 5) * 1000);
    const sending = runSend('tx-live-clock-stepped-back');
    try {
      try {
        await Promise.race([
          send.reached,
          sending.then(() => {
            throw new Error('send settled before reaching the proxy');
          })
        ]);
      } finally {
        clockStepped.mockRestore();
      }

      const live = txStore.find(r => r.id === 'tx-live-clock-stepped-back')!;
      expect(live.status).toBe(ITransactionStatus.GeneratingTransaction);
      expect(live.processingStartedAt).toBe(SESSION_STARTED_AT - 5);

      txStore.push({
        id: 'tx-orphan',
        type: 'send',
        accountId: 'acc-1',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: SESSION_STARTED_AT - 10,
        processingStartedAt: SESSION_STARTED_AT - 1
      });
      jest
        .mocked(Repo.transactions.filter)
        .mockImplementationOnce(pred => ({ toArray: async () => txStore.filter(row => pred(row as never)) }) as never);
      const liveBefore = { ...live };

      await failInterruptedTransactions();

      expect(live).toEqual(liveBefore);
      expect(txStore.find(r => r.id === 'tx-orphan')!.status).toBe(ITransactionStatus.Failed);
    } finally {
      send.release();
    }
    await sending;
  });

  it('spares the row this realm is sending when its stamp lies beyond the threshold ahead of the sweep clock', async () => {
    const send = holdNextProxySend();
    const sending = runSend('tx-live-far-ahead');
    try {
      await Promise.race([
        send.reached,
        sending.then(() => {
          throw new Error('send settled before reaching the proxy');
        })
      ]);

      const live = txStore.find(r => r.id === 'tx-live-far-ahead')!;
      expect(live.status).toBe(ITransactionStatus.GeneratingTransaction);
      const stamp = live.processingStartedAt;
      if (typeof stamp !== 'number') throw new Error('the writer left no stamp');

      txStore.push({
        id: 'tx-orphan',
        type: 'send',
        accountId: 'acc-1',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: SESSION_STARTED_AT - 10,
        processingStartedAt: SESSION_STARTED_AT - 1
      });
      const repo = jest.requireMock<{
        transactions: {
          filter: jest.Mock<
            { toArray: () => Promise<Array<Record<string, unknown>>> },
            [(row: Record<string, unknown>) => boolean]
          >;
        };
      }>('lib/miden/repo');
      repo.transactions.filter.mockImplementationOnce(pred => ({ toArray: async () => txStore.filter(pred) }));
      const liveBefore = { ...live };
      // Only the id set can spare it: the stamp is past what the sweep's clock allows another realm's row.
      const clockStepped = jest.spyOn(Date, 'now').mockReturnValue((stamp - MAX_WAIT_BEFORE_CANCEL - 1) * 1000);
      try {
        await failInterruptedTransactions();
      } finally {
        clockStepped.mockRestore();
      }

      expect(live).toEqual(liveBefore);
      expect(txStore.find(r => r.id === 'tx-orphan')!.status).toBe(ITransactionStatus.Failed);
    } finally {
      send.release();
    }
    await sending;
  });

  it('marks the row before its stamp write, so a sweep while that write is held spares it', async () => {
    const send = holdNextProxySend();
    const where = jest.mocked(Repo.transactions.where);
    const realWhere = where.getMockImplementation();
    let stampApplied!: () => void;
    const applied = new Promise<void>(resolve => (stampApplied = resolve));
    let releaseStamp!: () => void;
    const stampReleased = new Promise<void>(resolve => (releaseStamp = resolve));
    let stampHeld = false;
    // Applies the row's first write that moves it to GeneratingTransaction, then holds it open; later writes pass through.
    where.mockImplementation(
      query =>
        ({
          first: async () => txStore.find(r => r.id === query.id),
          modify: async (fn: (tx: Record<string, unknown>) => void) => {
            const row = txStore.find(r => r.id === query.id);
            if (!row) return;
            const before = row.status;
            fn(row);
            const setsGenerating =
              before !== ITransactionStatus.GeneratingTransaction &&
              row.status === ITransactionStatus.GeneratingTransaction;
            if (stampHeld || !setsGenerating) return;
            stampHeld = true;
            stampApplied();
            await stampReleased;
          }
        }) as never
    );
    // Stepped through the sweep, so the stamp is below the cutoff and only the id set can spare the row.
    const clockStepped = jest.spyOn(Date, 'now').mockReturnValue((SESSION_STARTED_AT - 5) * 1000);
    const sending = runSend('tx-live-marked-before-stamp');
    try {
      await Promise.race([
        applied,
        sending.then(() => {
          throw new Error('send settled before its stamp write');
        })
      ]);

      const live = txStore.find(r => r.id === 'tx-live-marked-before-stamp')!;
      expect(live.status).toBe(ITransactionStatus.GeneratingTransaction);
      expect(live.processingStartedAt).toBe(SESSION_STARTED_AT - 5);
      jest
        .mocked(Repo.transactions.filter)
        .mockImplementationOnce(pred => ({ toArray: async () => txStore.filter(row => pred(row as never)) }) as never);

      await failInterruptedTransactions();

      expect(live.status).not.toBe(ITransactionStatus.Failed);
    } finally {
      clockStepped.mockRestore();
      where.mockImplementation(realWhere);
      releaseStamp();
      send.release();
    }
    await sending;
  });
});
