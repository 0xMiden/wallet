// The report sites with the real reporter: only the Sentry boundary is mocked, so each assertion reads the text that
// would leave the device.
import * as Repo from 'lib/miden/repo';
import { __resetBackgroundTimeForTest, initBackgroundTimeTracking } from 'lib/mobile/background-time';
import { installHiddenDocument, type HiddenDocument } from 'lib/mobile/testing/hidden-document';
import { isMobile } from 'lib/platform';
import { captureCrash } from 'lib/telemetry/crash';

import {
  cancelStaleQueuedTransactions,
  cancelTransaction,
  cancelTransactionAfterPipelineStopped,
  markTransactionUnconfirmed,
  MAX_QUEUED_AGE
} from './cancel';
import { resolveUnconfirmedSwitch } from './complete';
import { USER_CANCELLED_TRANSACTION_REASON } from './constants';
import { updateTransactionStatus } from './helper';
import { AccountState, NodeReads } from './reconcile-reads';
import { judgeAndWrite } from './reconcile-unconfirmed';
import { OperationAbortedError } from '../back/offscreen-codec';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

jest.mock('lib/telemetry/crash', () => ({ captureCrash: jest.fn() }));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn()
}));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../sdk/miden-client', () => ({
  ...jest.requireActual('../sdk/miden-client'),
  withWasmClientLock: async (fn: (hold: object) => unknown) => fn({}),
  assertWasmHoldCurrent: () => {}
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isMobile: jest.fn(() => false) }));

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const TRANSACTION = hex(2);
const INITIAL = hex(10);
const FINAL = hex(11);
const OTHER = hex(12);
const NOTE = hex(20);
const NULLIFIER = hex(30);
const ACCOUNT = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';

const captured = () =>
  jest.mocked(captureCrash).mock.calls.map(([error, , options]) => ({
    message: (error as Error).message,
    level: options?.level
  }));

const expectNoTransactionData = (message: string) => {
  for (const leak of ['0x', ACCOUNT, 'Load failed', 'never went through', 'discarded this guardian switch']) {
    expect(message).not.toContain(leak);
  }
};

beforeEach(async () => {
  jest.clearAllMocks();
  await Repo.transactions.clear();
});

describe('the never-committed verdicts', () => {
  const evidence = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
    attemptId: 'a1',
    capturedAt: NOW - 60,
    source: 'stage',
    transactionId: TRANSACTION,
    initialCommitment: INITIAL,
    finalCommitment: FINAL,
    initialNonce: '5',
    outputNoteIds: [],
    nullifiers: [NULLIFIER],
    refBlock: 100,
    refBlockCommitment: HEADER,
    ...overrides
  });

  const claim = (entry: ISubmitEvidence): ITransaction => ({
    id: 'tx-1',
    type: 'consume',
    accountId: `${ACCOUNT}_s`,
    status: ITransactionStatus.Unconfirmed,
    initiatedAt: NOW - 120,
    completedAt: NOW - 100,
    error: `submission of transaction ${TRANSACTION} came back without a definite outcome`,
    mayHaveSubmitted: true,
    displayIcon: 'RECEIVE',
    stage: 'submitting',
    delegateTransaction: true,
    noteId: NOTE,
    submitEvidence: [entry]
  });

  const reads = (tip: AccountState, spentAt?: number): NodeReads => ({
    blockCommitment: async () => HEADER,
    account: async (_id, atBlock) =>
      atBlock === undefined ? { ok: true, state: tip } : { ok: false, pruned: true, timedOut: false },
    noteInclusions: async () => new Map(),
    nullifierHeight: async () => spentAt ?? null
  });

  it.each([
    ['expired', evidence({ expirationBlock: 700 }), reads({ blockNum: 750, commitment: INITIAL })],
    ['superseded', evidence(), reads({ blockNum: 150, commitment: OTHER, nonce: '6' })],
    ['spent_elsewhere', evidence(), reads({ blockNum: 160, commitment: INITIAL }, 150)]
  ])(
    'reports a claim proven never committed by the %s check as that, not as its own copy',
    async (rule, entry, node) => {
      await Repo.transactions.put(claim(entry));
      const outcome = await judgeAndWrite('tx-1', { node, nowSec: NOW, cadenceMs: 3_000 });
      expect(outcome.kind).toBe('never-committed');
      const [report, ...rest] = captured();
      expect(rest).toEqual([]);
      expect(report?.message).toContain(`; point node_verdict; never_committed; rule ${rule}`);
      expect(report?.message).toContain(
        rule === 'expired' ? '; proof wait unavailable. authentication' : '. authentication'
      );
      expect(report?.message).not.toContain('; network.');
      expect(report?.level).toBe('error');
      expectNoTransactionData(report?.message ?? '');
    }
  );

  it('retains the matching submit context when the node later proves expiry', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    const now = Date.now();
    const row: ITransaction = {
      ...claim(evidence({ expirationBlock: 700 })),
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'a1',
      stageTimestamps: { submitting: now - 5_000 }
    };
    await Repo.transactions.put(row);
    await markTransactionUnconfirmed(
      row,
      new Error(
        `failed to submit proven transaction: submission of transaction ${TRANSACTION} came back without a definite ` +
          'outcome, so the node may or may not have accepted it; nothing was recorded locally: grpc request failed for ' +
          'submit_proven_transaction: Miden node is unavailable; check that the node is running and reachable: ' +
          'TypeError: Load failed'
      )
    );
    await judgeAndWrite('tx-1', {
      node: reads({ blockNum: 750, commitment: INITIAL }),
      nowSec: NOW,
      cadenceMs: 3_000
    });
    const reports = captured();
    expect(reports).toHaveLength(2);
    expect(reports[1]?.message).toContain(
      '; prior submit_outcome_unknown; endpoint submit_proven_transaction; grpc unavailable; app hidden during submit no; submit leg under_9s'
    );
    expectNoTransactionData(reports[1]?.message ?? '');
    jest.mocked(isMobile).mockReturnValue(false);
    __resetBackgroundTimeForTest();
  });

  const indefiniteGrpc = (transactionId: string) =>
    new Error(
      `failed to submit proven transaction: submission of transaction ${transactionId} came back without a definite ` +
        'outcome, so the node may or may not have accepted it; nothing was recorded locally: grpc request failed for ' +
        'submit_proven_transaction: Miden node is unavailable; check that the node is running and reachable: ' +
        'TypeError: Load failed'
    );

  const cancelledDuringSubmit = (submittingAtMs: number): ITransaction => ({
    ...claim(evidence({ expirationBlock: 700 })),
    status: ITransactionStatus.Failed,
    error: USER_CANCELLED_TRANSACTION_REASON,
    attemptId: 'a1',
    cancelledInFlightAt: NOW - 5,
    stageTimestamps: { submitting: submittingAtMs }
  });

  it('retains submit context after a user cancellation', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    const row = cancelledDuringSubmit(Date.now() - 5_000);
    await Repo.transactions.put(row);
    await cancelTransactionAfterPipelineStopped(row, indefiniteGrpc(TRANSACTION), row.attemptId);
    const stored = await Repo.transactions.get('tx-1');
    expect(stored?.status).toBe(ITransactionStatus.Failed);
    expect(stored?.error).toBe(USER_CANCELLED_TRANSACTION_REASON);
    expect(stored?.rawError).toBeUndefined();
    expect(stored?.cancelledInFlightAt).toBeUndefined();
    await judgeAndWrite('tx-1', { node: reads({ blockNum: 750, commitment: INITIAL }), nowSec: NOW, cadenceMs: 3_000 });
    const reports = captured();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain(
      'prior submit_outcome_unknown; endpoint submit_proven_transaction; grpc unavailable; app hidden during submit no; submit leg under_9s'
    );
    expectNoTransactionData(reports[0]?.message ?? '');
    jest.mocked(isMobile).mockReturnValue(false);
    __resetBackgroundTimeForTest();
  });

  it('keeps the origin submit context when expiry commits on the evidence write', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    const row = cancelledDuringSubmit(Date.now() - 5_000);
    await Repo.transactions.put(row);
    const originalWhere = Repo.transactions.where.bind(Repo.transactions);
    let intercept = true;
    const where = jest.spyOn(Repo.transactions, 'where').mockImplementation(query => {
      const collection = originalWhere(query);
      if (intercept) {
        const modify = collection.modify.bind(collection);
        collection.modify = async changes => {
          const result = await modify(changes);
          intercept = false;
          await judgeAndWrite('tx-1', {
            node: reads({ blockNum: 750, commitment: INITIAL }),
            nowSec: NOW,
            cadenceMs: 3_000
          });
          return result;
        };
      }
      return collection;
    });
    try {
      await cancelTransactionAfterPipelineStopped(row, indefiniteGrpc(TRANSACTION), row.attemptId);
      expect(captured()[0]?.message).toContain(
        'prior submit_outcome_unknown; endpoint submit_proven_transaction; grpc unavailable; app hidden during submit no; submit leg under_9s'
      );
    } finally {
      where.mockRestore();
      jest.mocked(isMobile).mockReturnValue(false);
      __resetBackgroundTimeForTest();
    }
  });

  it('keeps the submit leg from the sample taken before the evidence upsert', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    const row = cancelledDuringSubmit(1_000_000);
    await Repo.transactions.put(row);
    let sampledNow = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => {
      sampledNow += 1;
      return sampledNow === 1 ? 1_008_999 : 1_009_000;
    });
    try {
      await cancelTransactionAfterPipelineStopped(row, indefiniteGrpc(TRANSACTION), row.attemptId);
      expect((await Repo.transactions.get('tx-1'))?.submitEvidence?.[0]?.submitContext?.leg).toBe('under_9s');
      await judgeAndWrite('tx-1', {
        node: reads({ blockNum: 750, commitment: INITIAL }),
        nowSec: NOW,
        cadenceMs: 3_000
      });
      expect(captured()[0]?.message).toContain('submit leg under_9s');
    } finally {
      clock.mockRestore();
      jest.mocked(isMobile).mockReturnValue(false);
      __resetBackgroundTimeForTest();
    }
  });

  it('leaves submit context unset when the indefinite error names another transaction', async () => {
    const row = cancelledDuringSubmit(Date.now() - 5_000);
    await Repo.transactions.put(row);
    await cancelTransactionAfterPipelineStopped(row, indefiniteGrpc(OTHER), row.attemptId);
    const stored = await Repo.transactions.get('tx-1');
    expect(stored?.status).toBe(ITransactionStatus.Failed);
    expect(stored?.error).toBe(USER_CANCELLED_TRANSACTION_REASON);
    expect(stored?.rawError).toBeUndefined();
    expect(stored?.submitEvidence?.[0]?.transactionId).toBe(TRANSACTION);
    expect(stored?.submitEvidence?.[0]?.submitContext).toBeUndefined();
  });

  it('retains measured context for an indefinite outcome without gRPC details', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    const row: ITransaction = {
      ...claim(evidence({ expirationBlock: 700 })),
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'a1',
      stageTimestamps: { submitting: Date.now() - 5_000 }
    };
    await Repo.transactions.put(row);
    await markTransactionUnconfirmed(
      row,
      new Error(`submission of transaction ${TRANSACTION} came back without a definite outcome`)
    );
    await judgeAndWrite('tx-1', { node: reads({ blockNum: 750, commitment: INITIAL }), nowSec: NOW, cadenceMs: 3_000 });
    expect(captured()[1]?.message).toContain(
      'endpoint unavailable; grpc unavailable; app hidden during submit no; submit leg under_9s'
    );
    jest.mocked(isMobile).mockReturnValue(false);
    __resetBackgroundTimeForTest();
  });

  it('does not attach submit context to a different current attempt', async () => {
    const row: ITransaction = {
      ...claim(evidence({ attemptId: 'a2', expirationBlock: 700 })),
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'a2',
      stageTimestamps: { submitting: Date.now() - 5_000 }
    };
    await Repo.transactions.put(row);
    await markTransactionUnconfirmed(
      { ...row, attemptId: 'a1' },
      new Error(
        `failed to submit proven transaction: submission of transaction ${TRANSACTION} came back without a definite ` +
          'outcome, so the node may or may not have accepted it; nothing was recorded locally: grpc request failed for ' +
          'submit_proven_transaction: Miden node is unavailable; check that the node is running and reachable: ' +
          'TypeError: Load failed'
      )
    );
    expect((await Repo.transactions.get('tx-1'))?.submitEvidence?.[0]?.submitContext).toBeUndefined();
  });

  it('does not attribute one attempt context to a multi-attempt expiry verdict', async () => {
    const row: ITransaction = {
      ...claim(evidence({ expirationBlock: 700 })),
      status: ITransactionStatus.GeneratingTransaction,
      attemptId: 'a1',
      stageTimestamps: { submitting: Date.now() - 5_000 }
    };
    await Repo.transactions.put(row);
    await markTransactionUnconfirmed(
      row,
      new Error(
        `failed to submit proven transaction: submission of transaction ${TRANSACTION} came back without a definite ` +
          'outcome, so the node may or may not have accepted it; nothing was recorded locally: grpc request failed for ' +
          'submit_proven_transaction: Miden node is unavailable; check that the node is running and reachable: ' +
          'TypeError: Load failed'
      )
    );
    await Repo.transactions.where({ id: 'tx-1' }).modify(fresh => {
      fresh.submitEvidence = [...(fresh.submitEvidence ?? []), evidence({ attemptId: 'a2', expirationBlock: 700 })];
    });
    await judgeAndWrite('tx-1', {
      node: reads({ blockNum: 750, commitment: INITIAL }),
      nowSec: NOW,
      cadenceMs: 3_000
    });
    expect(captured()[1]?.message).toContain(
      '; app hidden during submit unavailable; submit leg unavailable; proof wait'
    );
  });

  it('reports the verdict on a claim the pipeline already failed and reported at warning, so it is one error', async () => {
    const submitted: ITransaction = { ...claim(evidence()), status: ITransactionStatus.GeneratingTransaction };
    await Repo.transactions.put(submitted);
    await cancelTransactionAfterPipelineStopped(
      submitted,
      new Error(
        'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: invalid ' +
          `request parameters (transaction conflicts with current state: ${INITIAL})`
      )
    );
    expect((await Repo.transactions.get('tx-1'))?.status).toBe(ITransactionStatus.Failed);
    const outcome = await judgeAndWrite('tx-1', {
      node: reads({ blockNum: 150, commitment: OTHER, nonce: '6' }),
      nowSec: NOW,
      cadenceMs: 3_000
    });
    expect(outcome.kind).toBe('never-committed');
    const [pipeline, verdict, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(pipeline?.message).toContain('Transaction failed: tx_receive; stage submitting;');
    expect(pipeline?.message).toContain('; point pipeline; ');
    expect(pipeline?.level).toBe('error');
    expect(verdict?.message).toContain('Transaction failed: tx_receive; stage submitting;');
    expect(verdict?.message).toContain('; point node_verdict; never_committed; rule superseded. authentication');
    expect(verdict?.level).toBe('warning');
    expectNoTransactionData(`${pipeline?.message} ${verdict?.message}`);
  });

  it('reports a Guardian switch the node discarded as never committed, not as its own copy', async () => {
    await Repo.transactions.put({
      id: 'tx-1',
      type: 'switch-guardian',
      accountId: ACCOUNT,
      status: ITransactionStatus.Completed,
      initiatedAt: NOW - 120,
      displayIcon: 'DEFAULT',
      stage: 'confirming',
      extraInputs: { commitUnconfirmed: true }
    });
    await resolveUnconfirmedSwitch('tx-1', false);
    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain('; point guardian_node_verdict; never_committed. authentication');
    expect(report?.level).toBe('error');
    expectNoTransactionData(report?.message ?? '');
  });
});

describe('an unknown submit outcome at the Unconfirmed write', () => {
  const SUBMITTED_AT_MS = 1_800_000_000_000;
  let doc: HiddenDocument;
  let clock: jest.SpyInstance;

  const unavailable = () =>
    new Error(
      `failed to submit proven transaction: submission of transaction ${TRANSACTION} came back without a definite ` +
        'outcome, so the node may or may not have accepted it; nothing was recorded locally: grpc request failed for ' +
        'submit_proven_transaction: Miden node is unavailable; check that the node is running and reachable: ' +
        'TypeError: Load failed'
    );

  const submitting = (): ITransaction => ({
    id: 'tx-1',
    type: 'consume',
    accountId: ACCOUNT,
    status: ITransactionStatus.GeneratingTransaction,
    initiatedAt: SUBMITTED_AT_MS / 1000 - 30,
    processingStartedAt: SUBMITTED_AT_MS / 1000 - 20,
    attemptId: 'a1',
    stage: 'submitting',
    stageTimestamps: { sending: SUBMITTED_AT_MS - 20_000, submitting: SUBMITTED_AT_MS },
    delegateTransaction: true,
    displayIcon: 'RECEIVE'
  });

  beforeEach(() => {
    __resetBackgroundTimeForTest();
    doc = installHiddenDocument();
    clock = jest.spyOn(Date, 'now').mockReturnValue(SUBMITTED_AT_MS);
  });

  afterEach(() => {
    clock.mockRestore();
    doc.restore();
    __resetBackgroundTimeForTest();
    jest.mocked(isMobile).mockReturnValue(false);
  });

  it.each([
    ['backgrounded during the submit', true, 'yes'],
    ['in the foreground throughout', false, 'no']
  ])('on mobile, says the app was %s, at warning', async (_name, backgrounded, answer) => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    if (backgrounded) {
      clock.mockReturnValue(SUBMITTED_AT_MS + 1_000);
      doc.setHidden(true);
      clock.mockReturnValue(SUBMITTED_AT_MS + 4_000);
      doc.setHidden(false);
    }
    clock.mockReturnValue(SUBMITTED_AT_MS + 5_000);
    await Repo.transactions.put(submitting());
    await markTransactionUnconfirmed(submitting(), unavailable());
    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain(
      `Transaction unconfirmed: tx_receive; stage submitting; realm unknown; proving preference delegated;`
    );
    expect(report?.message).toContain(
      `; point pipeline; submit_outcome_unknown; endpoint submit_proven_transaction; grpc unavailable; app hidden during submit ${answer}; submit leg under_9s. authentication`
    );
    expect(report?.level).toBe('warning');
    expectNoTransactionData(report?.message ?? '');
  });

  it('counts a hidden stretch shorter than a second inside the submit', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    clock.mockReturnValue(SUBMITTED_AT_MS + 200);
    doc.setHidden(true);
    clock.mockReturnValue(SUBMITTED_AT_MS + 700);
    doc.setHidden(false);
    clock.mockReturnValue(SUBMITTED_AT_MS + 1_000);
    await Repo.transactions.put(submitting());
    await markTransactionUnconfirmed(submitting(), unavailable());
    expect(captured()[0]?.message).toContain('; app hidden during submit yes; submit leg under_9s. ');
  });

  it('does not count a hide that starts only once the submit has returned', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    await Repo.transactions.put(submitting());
    // The app goes to the background while the Unconfirmed write is in flight, and stays there past the report.
    const hideDuringWrite = () => {
      clock.mockReturnValue(SUBMITTED_AT_MS + 5_000);
      doc.setHidden(true);
      clock.mockReturnValue(SUBMITTED_AT_MS + 8_000);
    };
    Repo.transactions.hook('updating', hideDuringWrite);
    try {
      clock.mockReturnValue(SUBMITTED_AT_MS + 4_000);
      await markTransactionUnconfirmed(submitting(), unavailable());
    } finally {
      Repo.transactions.hook('updating').unsubscribe(hideDuringWrite);
    }
    expect((await Repo.transactions.get('tx-1'))?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(captured()[0]?.message).toContain('; app hidden during submit no; submit leg under_9s. ');
  });

  it('a hidden stretch that ended before the submit is not one during it', async () => {
    jest.mocked(isMobile).mockReturnValue(true);
    initBackgroundTimeTracking();
    clock.mockReturnValue(SUBMITTED_AT_MS - 10_000);
    doc.setHidden(true);
    clock.mockReturnValue(SUBMITTED_AT_MS - 2_000);
    doc.setHidden(false);
    clock.mockReturnValue(SUBMITTED_AT_MS + 5_000);
    await Repo.transactions.put(submitting());
    await markTransactionUnconfirmed(submitting(), unavailable());
    expect(captured()[0]?.message).toContain('; app hidden during submit no; submit leg under_9s. ');
  });

  it('off mobile, or with no submit stamp, cannot say', async () => {
    await Repo.transactions.put(submitting());
    await markTransactionUnconfirmed(submitting(), unavailable());
    jest.mocked(isMobile).mockReturnValue(true);
    await Repo.transactions.put({ ...submitting(), id: 'tx-2', stageTimestamps: undefined });
    await markTransactionUnconfirmed({ ...submitting(), id: 'tx-2' }, unavailable());
    const reports = captured();
    expect(reports).toHaveLength(2);
    for (const [index, report] of reports.entries()) {
      const bucket = index === 0 ? 'under_9s' : 'unavailable';
      expect(report.message).toContain(
        `; submit_outcome_unknown; endpoint submit_proven_transaction; grpc unavailable; app hidden during submit unavailable; submit leg ${bucket}. `
      );
    }
  });

  it('off mobile, measures the committed submit stamp to the return before the write', async () => {
    const pickedUp: ITransaction = { ...submitting(), stage: 'sending', stageTimestamps: undefined };
    await Repo.transactions.put(submitting());
    const advanceDuringWrite = () => {
      clock.mockReturnValue(SUBMITTED_AT_MS + 20_000);
    };
    Repo.transactions.hook('updating', advanceDuringWrite);
    try {
      clock.mockReturnValue(SUBMITTED_AT_MS + 9_500);
      await markTransactionUnconfirmed(pickedUp, unavailable());
    } finally {
      Repo.transactions.hook('updating').unsubscribe(advanceDuringWrite);
    }
    expect(captured()[0]?.message).toContain(
      '; submit_outcome_unknown; endpoint submit_proven_transaction; grpc unavailable; app hidden during submit unavailable; submit leg 9_to_11s. '
    );
  });

  it('off mobile, reports an unavailable submit leg when the committed row has no submit stamp', async () => {
    const row: ITransaction = { ...submitting(), stageTimestamps: undefined };
    await Repo.transactions.put(row);
    clock.mockReturnValue(SUBMITTED_AT_MS + 9_500);
    await markTransactionUnconfirmed(submitting(), unavailable());
    expect(captured()[0]?.message).toContain(
      '; submit_outcome_unknown; endpoint submit_proven_transaction; grpc unavailable; app hidden during submit unavailable; submit leg unavailable. '
    );
  });
});

describe('an unknown failure at the Failed write', () => {
  const SUBMITTED_AT_MS = 1_800_000_000_000;
  let clock: jest.SpyInstance;

  const submitting = (): ITransaction => ({
    id: 'tx-1',
    type: 'execute',
    accountId: ACCOUNT,
    status: ITransactionStatus.GeneratingTransaction,
    initiatedAt: SUBMITTED_AT_MS / 1000 - 30,
    stage: 'submitting',
    stageTimestamps: { submitting: SUBMITTED_AT_MS },
    delegateTransaction: true,
    displayIcon: 'DEFAULT'
  });

  beforeEach(() => {
    jest.mocked(isMobile).mockReturnValue(false);
    clock = jest.spyOn(Date, 'now').mockReturnValue(SUBMITTED_AT_MS + 9_500);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  it('off mobile, measures the committed submit stamp to the cancel before its first await', async () => {
    const pickedUp: ITransaction = { ...submitting(), stage: 'sending', stageTimestamps: undefined };
    await Repo.transactions.put(submitting());
    const advanceDuringWrite = () => {
      clock.mockReturnValue(SUBMITTED_AT_MS + 20_000);
    };
    const advanceDuringRead = (row: ITransaction) => {
      clock.mockReturnValue(SUBMITTED_AT_MS + 12_000);
      return row;
    };
    Repo.transactions.hook('reading', advanceDuringRead);
    Repo.transactions.hook('updating', advanceDuringWrite);
    try {
      expect(await cancelTransaction(pickedUp, new Error('opaque detail'))).toBe(true);
    } finally {
      Repo.transactions.hook('reading').unsubscribe(advanceDuringRead);
      Repo.transactions.hook('updating').unsubscribe(advanceDuringWrite);
    }
    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain(
      '; point pipeline; unknown; thrown error; app hidden during submit unavailable; submit leg 9_to_11s. authentication'
    );
    expect(report?.message).toContain('Transaction failed: tx_dapp; stage submitting;');
    expect(report?.level).toBe('error');
    expect((await Repo.transactions.get('tx-1'))?.status).toBe(ITransactionStatus.Failed);
    expectNoTransactionData(report?.message ?? '');
  });

  it('off mobile, reports an unavailable submit leg when the committed row has no submit stamp', async () => {
    const row: ITransaction = { ...submitting(), stageTimestamps: undefined };
    await Repo.transactions.put(row);
    expect(await cancelTransaction(submitting(), new Error('opaque detail'))).toBe(true);
    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain(
      '; point pipeline; unknown; thrown error; app hidden during submit unavailable; submit leg unavailable. authentication'
    );
    expect(report?.level).toBe('error');
    expect((await Repo.transactions.get('tx-1'))?.status).toBe(ITransactionStatus.Failed);
    expectNoTransactionData(report?.message ?? '');
  });

  describe('on mobile', () => {
    let doc: HiddenDocument;

    beforeEach(() => {
      __resetBackgroundTimeForTest();
      doc = installHiddenDocument();
      clock.mockReturnValue(SUBMITTED_AT_MS);
      jest.mocked(isMobile).mockReturnValue(true);
      initBackgroundTimeTracking();
    });

    afterEach(() => {
      doc.restore();
      __resetBackgroundTimeForTest();
      jest.mocked(isMobile).mockReturnValue(false);
    });

    it.each([
      ['backgrounded during the submit', true, 'yes'],
      ['in the foreground throughout', false, 'no']
    ])('says the app was %s', async (_name, backgrounded, answer) => {
      if (backgrounded) {
        clock.mockReturnValue(SUBMITTED_AT_MS + 1_000);
        doc.setHidden(true);
        clock.mockReturnValue(SUBMITTED_AT_MS + 4_000);
        doc.setHidden(false);
      }
      clock.mockReturnValue(SUBMITTED_AT_MS + 5_000);
      await Repo.transactions.put(submitting());
      expect(await cancelTransaction(submitting(), new Error('opaque detail'))).toBe(true);
      const [report, ...rest] = captured();
      expect(rest).toEqual([]);
      expect(report?.message).toContain(
        `; point pipeline; unknown; thrown error; app hidden during submit ${answer}; submit leg under_9s. authentication`
      );
      expectNoTransactionData(report?.message ?? '');
    });
  });
});

describe('a pre-flight sync killed by the offscreen deadline', () => {
  it('names the kill and its reason, at error', async () => {
    const row: ITransaction = {
      id: 'tx-1',
      type: 'consume',
      accountId: ACCOUNT,
      status: ITransactionStatus.Queued,
      initiatedAt: NOW - 30,
      stage: 'syncing',
      delegateTransaction: true,
      displayIcon: 'RECEIVE'
    };
    await Repo.transactions.put(row);
    await cancelTransactionAfterPipelineStopped(
      row,
      new OperationAbortedError('3f2c8a9e-1b4d-4c6e-9a7b-2d5e8f0c1a3b', 'deadline', {
        started: true,
        deadline: { owner: 'collateral', timer: 'started', killer: 'write' }
      })
    );
    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain('Transaction failed: tx_receive; stage syncing; realm unknown;');
    expect(report?.message).toContain(
      '; point pipeline; offscreen_aborted_deadline; deadline owner collateral; deadline timer started; deadline op write; op start reported yes. authentication'
    );
    expect(report?.message).not.toContain('3f2c8a9e');
    expect(report?.level).toBe('error');
  });
});

describe('the committed claim queue identity', () => {
  it.each<{ label: string; fail: (row: ITransaction) => Promise<unknown> }>([
    { label: 'cancel', fail: row => cancelTransaction(row, new Error('opaque detail')) },
    { label: 'unconfirmed', fail: row => markTransactionUnconfirmed(row, new Error('opaque detail')) },
    {
      label: 'status update',
      fail: row => updateTransactionStatus(row.id, ITransactionStatus.Failed, { error: 'opaque detail' })
    }
  ])('reports the stored deferral and admission through $label from a pickup that predates them', async ({ fail }) => {
    const pickedUp: ITransaction = {
      id: 'tx-1',
      type: 'consume',
      accountId: ACCOUNT,
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: NOW - 120,
      stage: 'submitting',
      displayIcon: 'RECEIVE'
    };
    await Repo.transactions.put({
      ...pickedUp,
      lastDeferral: 'guardian_rate_limited',
      feeAdmission: 'balance_unknown'
    });

    await fail(pickedUp);

    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain('; last deferral guardian_rate_limited;');
    expect(report?.message).toContain('; claim fee admission balance_unknown;');
    expectNoTransactionData(report?.message ?? '');
  });
});

// BREAD-WALLET-R: claims queued behind one blocked row expired together, and each was filed as an error.
describe('the queue expiry', () => {
  const queued = (id: string, stage?: ITransaction['stage']): ITransaction => ({
    id,
    type: 'consume',
    accountId: ACCOUNT,
    status: ITransactionStatus.Queued,
    initiatedAt: NOW - MAX_QUEUED_AGE - 60,
    delegateTransaction: true,
    displayIcon: 'RECEIVE',
    noteId: NOTE,
    ...(stage === undefined ? {} : { stage })
  });

  it('reports the last locked-wallet deferral when a requeued consume expires', async () => {
    await Repo.transactions.put({ ...queued('tx-locked', 'syncing'), lastDeferral: 'wallet_locked' });

    await cancelStaleQueuedTransactions();

    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain('; last deferral wallet_locked;');
    expect(report?.message).toContain('; point pipeline; queued_expired.');
    expect((await Repo.transactions.get('tx-locked'))?.status).toBe(ITransactionStatus.Failed);
    expectNoTransactionData(report?.message ?? '');
  });

  it('reports claims the loop never started at warning, and a requeued Guardian claim that had started at error', async () => {
    await Repo.transactions.bulkPut([queued('tx-1'), queued('tx-2'), queued('tx-3', 'creating-proposal')]);
    await cancelStaleQueuedTransactions();
    const reports = captured();
    expect(reports).toHaveLength(3);
    const neverStarted = reports.filter(({ message }) => message.includes('tx_receive; stage unknown; realm unknown;'));
    const started = reports.filter(({ message }) =>
      message.includes('tx_receive; stage signing; signing step creating_proposal; realm unknown;')
    );
    expect(neverStarted.map(({ level }) => level)).toEqual(['warning', 'warning']);
    expect(started.map(({ level }) => level)).toEqual(['error']);
    for (const { message } of reports) {
      expect(message).toMatch(/^Transaction failed: /);
      expect(message).toContain('; point pipeline; queued_expired. authentication');
      expectNoTransactionData(message);
    }
    const rows = await Repo.transactions.bulkGet(['tx-1', 'tx-2', 'tx-3']);
    expect(rows.map(row => row?.status)).toEqual([
      ITransactionStatus.Failed,
      ITransactionStatus.Failed,
      ITransactionStatus.Failed
    ]);
  });
});

describe('a submit the node refused as expired', () => {
  const EXECUTED_AT_MS = 1_800_000_000_000;
  let clock: jest.SpyInstance;

  const expired = () =>
    new Error(
      'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: ' +
        `invalid request parameters (transaction expired): status: 'invalid request parameters (transaction expired)', ` +
        `self: "tx ${TRANSACTION} for ${ACCOUNT}"`
    );

  // A 60 block window; the wait is converted at 3 s a block.
  const submitting = (waitMs: number | undefined, evidence: Partial<ISubmitEvidence> | null = {}): ITransaction => ({
    id: 'tx-1',
    type: 'execute',
    accountId: ACCOUNT,
    status: ITransactionStatus.GeneratingTransaction,
    initiatedAt: EXECUTED_AT_MS / 1000 - 30,
    stage: 'submitting',
    stageTimestamps:
      waitMs === undefined
        ? { submitting: EXECUTED_AT_MS }
        : { executing: EXECUTED_AT_MS, submitting: EXECUTED_AT_MS + waitMs },
    attemptId: 'a1',
    submitEvidence:
      evidence === null
        ? undefined
        : [
            {
              attemptId: 'a1',
              capturedAt: NOW,
              source: 'stage',
              refBlock: 1000,
              expirationBlock: 1060,
              ...evidence
            }
          ],
    delegateTransaction: true,
    displayIcon: 'DEFAULT'
  });

  beforeEach(() => {
    clock = jest.spyOn(Date, 'now').mockReturnValue(EXECUTED_AT_MS + 400_000);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  it.each([
    [89_999, 'under_half_window'],
    [90_000, 'over_half_window'],
    [180_000, 'over_half_window'],
    [180_001, 'past_window']
  ])('reports a wait of %s ms before submit against the evidence window as %s', async (waitMs, bucket) => {
    await Repo.transactions.put(submitting(waitMs));
    expect(await cancelTransaction(submitting(waitMs), expired())).toBe(true);
    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain(
      `; submit_rejected; endpoint submit_proven_transaction; grpc invalid_argument; node expired; proof wait ${bucket}. authentication`
    );
    expect(report?.message).not.toMatch(/\b(?:89999|90000|180000|180001|1000|1060|60)\b/);
    expectNoTransactionData(report?.message ?? '');
  });

  it.each([
    ['has no execution stamp', submitting(undefined)],
    ['has no evidence', submitting(100_000, null)],
    ['has evidence without an expiration', submitting(100_000, { expirationBlock: undefined })],
    ['has evidence without a reference block', submitting(100_000, { refBlock: undefined })],
    ['has evidence of another attempt only', submitting(100_000, { attemptId: 'a0' })]
  ])('reports the wait as unavailable when the row %s', async (_name, row) => {
    await Repo.transactions.put(row);
    expect(await cancelTransaction(row, expired())).toBe(true);
    expect(captured()[0]?.message).toContain('node expired; proof wait unavailable. authentication');
  });
});
