// The report sites with the real reporter: only the Sentry boundary is mocked, so each assertion reads the text that
// would leave the device.
import * as Repo from 'lib/miden/repo';
import { __resetBackgroundTimeForTest, initBackgroundTimeTracking } from 'lib/mobile/background-time';
import { installHiddenDocument, type HiddenDocument } from 'lib/mobile/testing/hidden-document';
import { isMobile } from 'lib/platform';
import { captureCrash } from 'lib/telemetry/crash';

import { cancelTransactionAfterPipelineStopped, markTransactionUnconfirmed } from './cancel';
import { resolveUnconfirmedSwitch } from './complete';
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
      expect(report?.message).toContain(`; point node_verdict; never_committed; rule ${rule}. authentication`);
      expect(report?.message).not.toContain('; network.');
      expect(report?.level).toBe('error');
      expectNoTransactionData(report?.message ?? '');
    }
  );

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
      `; point pipeline; submit_outcome_unknown; grpc unavailable; app hidden during submit ${answer}. authentication`
    );
    expect(report?.level).toBe('warning');
    expectNoTransactionData(report?.message ?? '');
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
    expect(captured()[0]?.message).toContain('; app hidden during submit no. ');
  });

  it('off mobile, or with no submit stamp, cannot say', async () => {
    await Repo.transactions.put(submitting());
    await markTransactionUnconfirmed(submitting(), unavailable());
    jest.mocked(isMobile).mockReturnValue(true);
    await Repo.transactions.put({ ...submitting(), id: 'tx-2', stageTimestamps: undefined });
    await markTransactionUnconfirmed({ ...submitting(), id: 'tx-2' }, unavailable());
    const reports = captured();
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.message).toContain(
        '; submit_outcome_unknown; grpc unavailable; app hidden during submit unavailable. '
      );
    }
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
      new OperationAbortedError('3f2c8a9e-1b4d-4c6e-9a7b-2d5e8f0c1a3b', 'deadline')
    );
    const [report, ...rest] = captured();
    expect(rest).toEqual([]);
    expect(report?.message).toContain('Transaction failed: tx_receive; stage syncing; realm unknown;');
    expect(report?.message).toContain('; point pipeline; offscreen_aborted_deadline. authentication');
    expect(report?.message).not.toContain('3f2c8a9e');
    expect(report?.level).toBe('error');
  });
});
