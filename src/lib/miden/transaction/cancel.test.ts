// Light mocks so importing cancel.ts doesn't pull in Dexie / the WASM client proxy.
import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { GuardianSwitchDiscardedError, GuardianWriteDiscardedError } from 'lib/miden/guardian/direct-switch';
import { StaleProofError } from 'lib/miden/guardian/proof-freshness';
import { ApplyAfterSubmitError } from 'lib/miden/sdk/sdk-error-code';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import {
  __resetBackgroundTimeForTest,
  hiddenSecondsSince,
  initBackgroundTimeTracking
} from 'lib/mobile/background-time';
import { captureDiagnosticLog } from 'lib/telemetry/crash';
import { _resetDiagnosticLogLimitsForTest } from 'lib/telemetry/diagnostic-log';

import {
  cancelTransaction,
  cancelTransactionAfterPipelineStopped,
  cancelStuckTransactions,
  queueHiddenBucket,
  SESSION_STARTED_AT,
  isTransactionStuck
} from './cancel';
import {
  CLAIM_VAULT_SHORTFALL_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_STUCK_ERROR,
  TRANSACTION_VAULT_SHORTFALL_ERROR,
  USER_CANCELLED_TRANSACTION_REASON
} from './constants';
import { clearCancelledInFlight, markCancelledInFlight, markMayHaveSubmitted, recordKillEnd } from './helper';
import {
  notifyBackgroundTransactionFailed,
  notifyBackgroundTransactionNotConfirmed
} from '../back/background-notification';
import { ConsumeTransaction, ITransaction, ITransactionStatus, Transaction } from '../db/types';
import { NoteTypeEnum } from '../types';

// A table of rows keyed by id, enough for cancelTransaction's read and its guarded modify.
const mockRows = new Map<string, Record<string, unknown>>();
// Set by the race test only: swaps in a brand-new row object the first time first() is
// called for that id, simulating a write that commits between the read and the modify
// below. A new object, never a mutation of the one first() already returned - mutating in
// place would change what that earlier read sees too, since first() returns the stored
// object itself.
let mockRaceRow: { id: string; row: Record<string, unknown> } | undefined;
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: ({ id }: { id: string }) => ({
      first: async () => {
        const row = mockRows.get(id);
        if (mockRaceRow?.id === id) {
          mockRows.set(id, mockRaceRow.row);
          mockRaceRow = undefined;
        }
        return row;
      },
      modify: async (fn: (row: Record<string, unknown>) => unknown) => {
        const row = mockRows.get(id);
        if (!row) return;
        const draft = { ...row };
        if (fn(draft) !== false) mockRows.set(id, draft);
      }
    })
  }
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/telemetry/crash', () => ({
  ...jest.requireActual('lib/telemetry/crash'),
  captureDiagnosticLog: jest.fn()
}));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn(),
  showBackgroundNotification: jest.fn()
}));
jest.mock('lib/telemetry/transaction-failure', () => ({ reportTransactionFailure: jest.fn() }));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => true) }));
jest.mock('lib/mobile/background-time', () => ({
  ...jest.requireActual('lib/mobile/background-time'),
  hiddenSecondsSince: jest.fn(() => 0)
}));
jest.mock('./get', () => ({ getTransactionsInProgress: jest.fn() }));
jest.mock('./helper', () => ({
  updateTransactionStatus: jest.fn(),
  markMayHaveSubmitted: jest.fn(),
  markCancelledInFlight: jest.fn(),
  clearCancelledInFlight: jest.fn(),
  recordKillEnd: jest.fn(async () => {}),
  recordOutOfBandEnd: jest.fn(async () => {})
}));
jest.mock('../sdk/miden-client', () => ({ withWasmClientLock: jest.fn() }));

describe('isTransactionStuck', () => {
  const MAX = 120; // 2 min (mobile) in seconds

  it('treats a tx with no processingStartedAt as stuck (crashed mid-transition)', () => {
    expect(isTransactionStuck(undefined, 1000, 0, MAX)).toBe(true);
  });

  it('is NOT stuck when active (foreground) elapsed is under the threshold', () => {
    // wall-clock elapsed = 100s, hidden = 0 → active 100s < 120s
    expect(isTransactionStuck(1000, 1100, 0, MAX)).toBe(false);
  });

  it('is stuck when active elapsed exceeds the threshold', () => {
    // wall-clock elapsed = 200s, hidden = 0 → active 200s > 120s
    expect(isTransactionStuck(1000, 1200, 0, MAX)).toBe(true);
  });

  it('does NOT reap when most of the elapsed time was spent backgrounded (#473)', () => {
    // wall-clock elapsed = 300s but 250s of it was hidden → active 50s < 120s.
    // The old wall-clock-only check reaped this as a false REMOTE_PROVER_TIMEOUT.
    expect(isTransactionStuck(1000, 1300, 250, MAX)).toBe(false);
  });

  it('still reaps when active foreground time alone exceeds the threshold', () => {
    // wall-clock elapsed = 400s, hidden = 100s → active 300s > 120s
    expect(isTransactionStuck(1000, 1400, 100, MAX)).toBe(true);
  });

  it('is NOT stuck however far in the future the stamp lies (the clock moved backwards)', () => {
    // A row this realm is still driving can carry a future stamp after a clock step back (#1202).
    expect(isTransactionStuck(1000, 1000 - MAX - 1, 0, MAX)).toBe(false);
  });
});

// The background notice follows the same rule as every other reader of a failed row (#1250):
// a row whose outcome is unknown is announced as not confirmed, never as failed.
describe('cancelTransaction background notification', () => {
  const inFlight = (id: string, fields: Record<string, unknown> = {}): Transaction => {
    const row = {
      id,
      type: 'send',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      stage: 'proving',
      initiatedAt: 0,
      displayIcon: 'SEND',
      ...fields
    };
    mockRows.set(id, row);
    return row as unknown as Transaction;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.clear();
    mockRaceRow = undefined;
  });

  it('announces a row whose write races the read - a submit stamp landing between them - as not confirmed', async () => {
    const tx = inFlight('tx-1'); // no mayHaveSubmitted, stage 'proving'
    mockRaceRow = { id: 'tx-1', row: { ...mockRows.get('tx-1'), mayHaveSubmitted: true } };

    await expect(cancelTransaction(tx, new Error('prover returned 503'))).resolves.toBe(true);

    expect(mockRows.get('tx-1')?.status).toBe(ITransactionStatus.Failed);
    expect(notifyBackgroundTransactionNotConfirmed).toHaveBeenCalledTimes(1);
    expect(notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
  });

  it('leaves a row that turned Unconfirmed between the read and the write, announcing nothing (#1081)', async () => {
    // The read saw it in flight; a cancel, reaper or verifier holding no loop lock must not settle the unknown outcome.
    const tx = inFlight('tx-1');
    mockRaceRow = { id: 'tx-1', row: { ...mockRows.get('tx-1'), status: ITransactionStatus.Unconfirmed } };

    await expect(cancelTransaction(tx, new Error('x'))).resolves.toBe(false);

    expect(mockRows.get('tx-1')?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
    expect(notifyBackgroundTransactionNotConfirmed).not.toHaveBeenCalled();
  });

  it.each([
    ['a row that may have been submitted', { mayHaveSubmitted: true }, new Error('prover returned 503')],
    ['a row the reaper failed', {}, TRANSACTION_STUCK_ERROR]
  ])('announces %s as not confirmed', async (_label, fields, error) => {
    await expect(cancelTransaction(inFlight('tx-1', fields), error)).resolves.toBe(true);

    expect(mockRows.get('tx-1')?.status).toBe(ITransactionStatus.Failed);
    expect(notifyBackgroundTransactionNotConfirmed).toHaveBeenCalledTimes(1);
    expect(notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
  });

  it('announces a definite failure as failed', async () => {
    await cancelTransaction(inFlight('tx-1'), new Error('prover returned 503'));

    expect(notifyBackgroundTransactionFailed).toHaveBeenCalledTimes(1);
    expect(notifyBackgroundTransactionNotConfirmed).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a rotation',
      fields: { type: 'replace-hot-key', mayHaveSubmitted: true, extraInputs: { newHotPublicKey: 'hot-pub' } },
      error: new GuardianWriteDiscardedError('Guardian replace-hot-key 0xabc did not land: the node discarded it.')
    },
    {
      label: 'a switch',
      fields: {
        type: 'switch-guardian',
        mayHaveSubmitted: true,
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
      },
      error: new GuardianSwitchDiscardedError('0xabc')
    }
  ])(
    'announces $label the node discarded as failed, recording the verdict in the write that fails it (#1233)',
    async ({ fields, error }) => {
      await expect(cancelTransaction(inFlight('tx-1', fields), error)).resolves.toBe(true);

      const row = mockRows.get('tx-1');
      expect(row?.status).toBe(ITransactionStatus.Failed);
      expect(row?.extraInputs).toEqual({ ...fields.extraInputs, nodeDiscarded: true });
      expect(notifyBackgroundTransactionFailed).toHaveBeenCalledTimes(1);
      expect(notifyBackgroundTransactionNotConfirmed).not.toHaveBeenCalled();
    }
  );

  it('never reads a discard from message text (#1233)', async () => {
    const tx = inFlight('tx-1', { type: 'replace-hot-key', mayHaveSubmitted: true });

    await cancelTransaction(tx, new Error('Guardian replace-hot-key 0xabc did not land: the node discarded it.'));

    expect(mockRows.get('tx-1')?.extraInputs).toBeUndefined();
    expect(notifyBackgroundTransactionNotConfirmed).toHaveBeenCalledTimes(1);
  });

  it('announces nothing for a user cancel', async () => {
    await cancelTransaction(inFlight('tx-1'), USER_CANCELLED_TRANSACTION_REASON);

    expect(notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
    expect(notifyBackgroundTransactionNotConfirmed).not.toHaveBeenCalled();
  });
});

// A kill wrapped in another error is still a kill: the pipeline may still submit (#1313).
describe('the end of a swap, recorded when its row fails (#1660)', () => {
  const swapRow = (id: string): Transaction => {
    const row = {
      id,
      type: 'swap',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      stage: 'creating-proposal',
      initiatedAt: Math.floor(Date.now() / 1000) - 3,
      displayIcon: 'SWAP'
    };
    mockRows.set(id, row);
    return row as unknown as Transaction;
  };
  const ends = () => jest.mocked(captureDiagnosticLog).mock.calls.map(([event, attributes]) => [event, attributes]);

  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.clear();
    _resetDiagnosticLogLimitsForTest();
  });

  it.each([
    ['a user cancel', USER_CANCELLED_TRANSACTION_REASON, 'cancelled'],
    ['the stuck reaper', TRANSACTION_STUCK_ERROR, 'timeout'],
    ['the startup sweep', TRANSACTION_INTERRUPTED_ON_STARTUP, 'interrupted'],
    ['a proof that kept going stale', new StaleProofError(), 'timeout'],
    ['a failure that timed out', new Error('guardian request timed out'), 'timeout'],
    ['any other failure', new Error('mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe refused'), 'failed']
  ])('names %s as %s', async (_label, error, outcome) => {
    await cancelTransaction(swapRow('swap-1'), error);
    expect(ends()).toEqual([['operation_end', { operation: 'swap', outcome, duration: '1_to_5s' }]]);
  });

  it('records nothing for a row that was not failed', async () => {
    const row = swapRow('swap-2');
    mockRows.set('swap-2', { ...row, status: ITransactionStatus.Completed });
    await cancelTransaction(row, new Error('late'));
    expect(captureDiagnosticLog).not.toHaveBeenCalled();
  });

  it('records nothing for a transaction other than a swap', async () => {
    const row = swapRow('send-1');
    mockRows.set('send-1', { ...row, type: 'send' });
    await cancelTransaction(row, new Error('failed'));
    expect(captureDiagnosticLog).not.toHaveBeenCalled();
  });
});

describe('cancelTransactionAfterPipelineStopped with a kill wrapped in another error', () => {
  const sendRow = (fields: Record<string, unknown> = {}): Transaction => {
    const row = {
      id: 'tx-1',
      type: 'send',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      stage: 'sending',
      processingStartedAt: 1,
      initiatedAt: 0,
      ...fields
    };
    mockRows.set('tx-1', row);
    return row as unknown as Transaction;
  };
  const wrap = (cause: Error) => new Error('send failed', { cause });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.clear();
    mockRaceRow = undefined;
  });

  it('records that a send may have submitted when a deadline kill is the cause', async () => {
    await cancelTransactionAfterPipelineStopped(sendRow(), wrap(new OperationAbortedError('op-1', 'deadline')));

    expect(markMayHaveSubmitted).toHaveBeenCalledWith('tx-1');
    expect(markCancelledInFlight).not.toHaveBeenCalled();
    expect(mockRows.get('tx-1')?.status).toBe(ITransactionStatus.Failed);
  });

  it('also records the pipeline as still in flight when an eviction is the cause', async () => {
    await cancelTransactionAfterPipelineStopped(sendRow(), wrap(new WasmClientPoisonedError('watchdog')));

    expect(markMayHaveSubmitted).toHaveBeenCalledWith('tx-1');
    expect(markCancelledInFlight).toHaveBeenCalledWith('tx-1');
  });

  it('records that a send may have submitted when a terminated client is the cause, as for an abort', async () => {
    await cancelTransactionAfterPipelineStopped(sendRow(), wrap(new Error('WebClient terminated')));

    expect(recordKillEnd).toHaveBeenCalledWith('tx-1', undefined);
    expect(markMayHaveSubmitted).toHaveBeenCalledWith('tx-1');
    expect(markCancelledInFlight).not.toHaveBeenCalled();
  });

  it('keeps a landed write out of the kill route when a terminated client failed its local apply', async () => {
    await cancelTransactionAfterPipelineStopped(sendRow(), new ApplyAfterSubmitError(new Error('Client terminated')));

    expect(recordKillEnd).not.toHaveBeenCalled();
    expect(markMayHaveSubmitted).not.toHaveBeenCalled();
  });

  it('records no crossing for a wrapped kill of a row that never built a write', async () => {
    const preWrite = sendRow({ status: ITransactionStatus.Queued, stage: 'syncing', processingStartedAt: undefined });

    await cancelTransactionAfterPipelineStopped(preWrite, wrap(new WasmClientPoisonedError('watchdog')));

    expect(markMayHaveSubmitted).not.toHaveBeenCalled();
    expect(markCancelledInFlight).not.toHaveBeenCalled();
    expect(clearCancelledInFlight).toHaveBeenCalledWith('tx-1');
  });
});

// A claim has no amount sent, so its shortfall stores the claim copy whatever scripts its notes run.
describe('cancelTransactionAfterPipelineStopped storing a vault shortfall', () => {
  const shortfall = new Error('assertion failed with error code: 644413868907058392');
  const failingRow = (fields: Record<string, unknown>): Transaction => {
    const row = {
      ...fields,
      id: 'tx-1',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      stage: 'creating-proposal',
      processingStartedAt: 1,
      initiatedAt: 0
    };
    mockRows.set('tx-1', row);
    return row as unknown as Transaction;
  };
  const standardPayment = {
    id: 'note-1',
    faucetId: 'faucet-1',
    amount: '10',
    senderAddress: 'sender-1',
    isBeingClaimed: false,
    type: NoteTypeEnum.Public,
    standardPayment: true
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.clear();
    mockRaceRow = undefined;
  });

  it.each([
    ['queued by id or by a dApp, which carries no note verdicts', () => ({ type: 'consume' })],
    ['of standard payments', () => ({ ...new ConsumeTransaction('acc-1', [standardPayment]) })]
  ])('stores the claim copy on a claim %s', async (_label, fields) => {
    await cancelTransactionAfterPipelineStopped(failingRow(fields()), shortfall);

    const row = mockRows.get('tx-1');
    expect(row?.error).not.toContain('amount sent');
    expect(row?.error).toBe(CLAIM_VAULT_SHORTFALL_ERROR);
    expect(row?.rawError).toBe(`Error: ${shortfall.message}`);
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(notifyBackgroundTransactionFailed).toHaveBeenCalledTimes(1);
    expect(notifyBackgroundTransactionNotConfirmed).not.toHaveBeenCalled();
  });

  it('keeps the generic copy on a send, which withdraws the amount sent as well as the fee', async () => {
    await cancelTransactionAfterPipelineStopped(failingRow({ type: 'send' }), shortfall);

    expect(mockRows.get('tx-1')?.error).toBe(TRANSACTION_VAULT_SHORTFALL_ERROR);
  });
});

describe('selected-to-committed reaper evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.clear();
    mockRaceRow = undefined;
  });
  const selected = (id: string, start = SESSION_STARTED_AT - 3600) => ({
    id,
    type: 'execute',
    accountId: 'private',
    status: ITransactionStatus.GeneratingTransaction,
    stage: 'proving',
    initiatedAt: 1,
    processingStartedAt: start,
    displayIcon: 'DEFAULT'
  });
  it.each(['processingStartedAt', 'id'])(
    'reports unavailable for changed committed %s without changing cancellation',
    async changed => {
      const tx = selected('race');
      mockRows.set(tx.id, tx);
      mockRaceRow = {
        id: tx.id,
        row: { ...tx, ...(changed === 'id' ? { id: 'changed-id' } : { processingStartedAt: SESSION_STARTED_AT }) }
      };
      const { getTransactionsInProgress } = jest.requireMock('./get');
      getTransactionsInProgress.mockResolvedValueOnce([tx]);
      await cancelStuckTransactions();
      const { reportTransactionFailure } = jest.requireMock('lib/telemetry/transaction-failure');
      expect(getTransactionsInProgress).toHaveBeenCalledTimes(1);
      expect(reportTransactionFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'stuck_reaped',
          reap: expect.objectContaining({ startRelation: 'unavailable' })
        })
      );
      expect(mockRows.get(tx.id)?.status).toBe(ITransactionStatus.Failed);
    }
  );
  it('does not report or consume queue evidence when cancellation is refused', async () => {
    const tx = selected('refused');
    mockRows.set(tx.id, tx);
    mockRaceRow = { id: tx.id, row: { ...tx, status: ITransactionStatus.Completed } };
    const { recordQueueAdmission, consumeQueueAdmission } = await import('./queue-admission-diagnostics');
    recordQueueAdmission(tx, 'selected');
    const { getTransactionsInProgress } = jest.requireMock('./get');
    getTransactionsInProgress.mockResolvedValueOnce([tx]);
    await cancelStuckTransactions();
    expect(jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure).not.toHaveBeenCalled();
    expect(consumeQueueAdmission(tx)).toBe('selected');
    expect(mockRows.get(tx.id)?.status).toBe(ITransactionStatus.Completed);
  });
});

it('keeps concurrent reaper timestamp observations local to each selected row', async () => {
  jest.clearAllMocks();
  mockRows.clear();
  mockRaceRow = undefined;
  const make = (id: string, type: string, start: number) => ({
    id,
    type,
    accountId: 'private',
    status: ITransactionStatus.GeneratingTransaction,
    stage: 'proving',
    initiatedAt: 1,
    processingStartedAt: start,
    displayIcon: 'DEFAULT'
  });
  const first = make('private-first', 'execute', SESSION_STARTED_AT - 3600),
    second = make('private-second', 'send', SESSION_STARTED_AT + 1);
  mockRows.set(first.id, first);
  mockRows.set(second.id, second);
  const { getTransactionsInProgress } = jest.requireMock('./get');
  getTransactionsInProgress.mockResolvedValueOnce([first, second]);
  const clock = jest.spyOn(Date, 'now').mockReturnValue((SESSION_STARTED_AT + 86400) * 1000);
  try {
    await cancelStuckTransactions();
  } finally {
    clock.mockRestore();
  }
  const { reportTransactionFailure } = jest.requireMock('lib/telemetry/transaction-failure');
  expect(getTransactionsInProgress).toHaveBeenCalledTimes(1);
  expect(reportTransactionFailure).toHaveBeenCalledTimes(2);
  expect(reportTransactionFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'execute',
      reap: expect.objectContaining({ startRelation: 'before_realm_cutoff' })
    })
  );
  expect(reportTransactionFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'send',
      reap: expect.objectContaining({ startRelation: 'at_or_after_realm_cutoff' })
    })
  );
  const serialized = JSON.stringify(reportTransactionFailure.mock.calls);
  expect(serialized).not.toContain('private-first');
  expect(serialized).not.toContain('private-second');
  expect(serialized).not.toContain(String(SESSION_STARTED_AT));
});

describe('queueHiddenBucket', () => {
  const row = { initiatedAt: 1_000 } as ITransaction;
  const nowMs = 4_600_000;
  afterEach(() => {
    __resetBackgroundTimeForTest();
    jest.mocked(hiddenSecondsSince).mockReset();
    jest.mocked(hiddenSecondsSince).mockImplementation(() => 0);
  });
  it('stays unobserved until this run is recording background time', () => {
    expect(queueHiddenBucket(row, nowMs)).toBe('unobserved');
    expect(queueHiddenBucket({ initiatedAt: Number.NaN } as ITransaction, nowMs)).toBe('unobserved');
  });
  it('splits a recorded wait into none, under half and half or more', () => {
    initBackgroundTimeTracking();
    const hidden = jest.mocked(hiddenSecondsSince);
    hidden.mockReturnValue(0);
    expect(queueHiddenBucket(row, nowMs)).toBe('none');
    hidden.mockReturnValue(1_799);
    expect(queueHiddenBucket(row, nowMs)).toBe('under_half');
    hidden.mockReturnValue(1_800);
    expect(queueHiddenBucket(row, nowMs)).toBe('half_or_more');
    expect(queueHiddenBucket({ initiatedAt: Number.NaN } as ITransaction, nowMs)).toBe('unavailable');
  });
});
