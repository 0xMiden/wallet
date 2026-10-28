import { Capacitor, registerPlugin } from '@capacitor/core';

import * as Repo from 'lib/miden/repo';
import { captureCrash } from 'lib/telemetry/crash';
import { reportTransactionFailure } from 'lib/telemetry/transaction-failure';
import { NativeReown, type ReownPlugin } from 'lib/walletconnect/native';
import { readReownNativeFailure, type ReownNativeFailure } from 'lib/walletconnect/native-request-failure';

import {
  cancelStaleQueuedTransactions,
  cancelStuckTransactions,
  cancelTransaction,
  failInterruptedTransactions,
  markStartedInThisRealm,
  markTransactionUnconfirmed,
  MAX_QUEUED_AGE,
  MAX_WAIT_BEFORE_CANCEL,
  SESSION_STARTED_AT,
  verifyStuckTransactionsFromNode
} from './cancel';
import {
  markBridgedSendFailed,
  resolveUnconfirmedSwitch,
  updateBridgedReceivePhase,
  updateEarnWithdrawPhase
} from './complete';
import {
  INVALID_NOTE_ERROR,
  ROTATION_FUNDING_NON_NATIVE_ERROR,
  ROTATION_FUNDING_NOTE_UNAVAILABLE_ERROR,
  ROTATION_PENDING_CONSUME_ERROR,
  RotationGateConsumeRefusal,
  TRANSACTION_EXPIRED_ERROR,
  TRANSACTION_FORCE_CANCELLED_ERROR,
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  TRANSACTION_STUCK_ERROR,
  UNCONFIRMED_FAILURE_REASONS,
  USER_CANCELLED_TRANSACTION_REASON,
  WALLET_FAILURE_REASONS
} from './constants';
import { updateTransactionStatus } from './helper';
import { generateTransactionsLoop } from './index';
import { recordQueueAdmission, consumeQueueAdmission, pruneQueueAdmission } from './queue-admission-diagnostics';
import { ITransaction, ITransactionStatus } from '../db/types';

jest.mock('lib/telemetry/transaction-failure', () => ({ reportTransactionFailure: jest.fn() }));
jest.mock('lib/telemetry/crash', () => ({ captureCrash: jest.fn() }));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn()
}));
const mockNoteDetails = jest.fn(async (): Promise<unknown[]> => []);
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: { getInputNoteDetails: () => mockNoteDetails() }
}));
jest.mock('../sdk/miden-client', () => ({
  ...jest.requireActual('../sdk/miden-client'),
  withWasmClientLock: async (fn: (hold: object) => unknown) => fn({}),
  assertWasmHoldCurrent: () => {}
}));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isMobile: () => false }));
jest.mock('@capacitor/core', () => {
  const actual = jest.requireActual<typeof import('@capacitor/core')>('@capacitor/core');
  const reown = { sendTransaction: jest.fn() };
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, getPlatform: jest.fn(actual.Capacitor.getPlatform) },
    registerPlugin: jest.fn((name: string, implementations?: Parameters<typeof actual.registerPlugin>[1]) =>
      name === 'Reown' ? reown : actual.registerPlugin(name, implementations)
    )
  };
});

const rawReown = registerPlugin<ReownPlugin>('Reown');
const { Capacitor: actualCapacitor } = jest.requireActual<typeof import('@capacitor/core')>('@capacitor/core');
const report = jest.mocked(reportTransactionFailure);
const row = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx',
  type: 'execute',
  accountId: 'private-account',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 1000,
  displayIcon: 'DEFAULT',
  stage: 'proving',
  delegateTransaction: true,
  ...overrides
});
const phased = (type: 'earn-withdraw' | 'bridged-receive', phase: string): ITransaction =>
  row({ type, status: ITransactionStatus.Completed, extraInputs: { phase } });

beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(Capacitor.getPlatform).mockImplementation(actualCapacitor.getPlatform);
  jest.mocked(rawReown.sendTransaction).mockReset();
  await Repo.transactions.clear();
});

describe('committed terminal transaction failure reports', () => {
  it('uses the persisted operation, stage and proving route rather than stale caller fields', async () => {
    const error = new Error('assertion failed');
    await Repo.transactions.put(row());

    await cancelTransaction(row({ type: 'send', stage: 'syncing', delegateTransaction: false }), error);

    expect((await Repo.transactions.get('tx'))?.status).toBe(ITransactionStatus.Failed);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      point: 'pipeline',
      type: 'execute',
      stage: 'proving',
      delegateTransaction: true,
      diagnostics: undefined,
      error,
      submitCrossing: 'unavailable'
    });
  });

  it('forwards only the stored request diagnostics alongside the closed transaction fields', async () => {
    const diagnostics = { authPreparation: 'wallet_enriched', authLayout: 'fee', commitmentMatch: 'fee' } as const;
    await Repo.transactions.put(row({ failureDiagnostics: diagnostics }));
    await cancelTransaction(row(), 'failed');
    expect(report).toHaveBeenCalledWith({
      point: 'pipeline',
      type: 'execute',
      stage: 'proving',
      delegateTransaction: true,
      diagnostics,
      error: 'failed',
      submitCrossing: 'unavailable'
    });
  });

  it.each([USER_CANCELLED_TRANSACTION_REASON, TRANSACTION_INTERRUPTED_ON_STARTUP])(
    'reports the actual Failed transition for %s too',
    async error => {
      await Repo.transactions.put(row());
      await cancelTransaction(row(), error);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ error }));
    }
  );

  it.each([
    ['a user cancel', USER_CANCELLED_TRANSACTION_REASON, 'user_cancelled'],
    ['the startup sweep', TRANSACTION_INTERRUPTED_ON_STARTUP, 'interrupted_on_startup'],
    ['the queue expiry', TRANSACTION_EXPIRED_ERROR, 'queued_expired'],
    ['the node check of an unconsumed note', TRANSACTION_INTERRUPTED_ERROR, 'consume_not_landed'],
    ['the node check of an invalid note', INVALID_NOTE_ERROR, 'note_invalid'],
    ['the rotation gate', new RotationGateConsumeRefusal(ROTATION_PENDING_CONSUME_ERROR), 'rotation_key_pending'],
    [
      'the rotation claim of a vanished note',
      new RotationGateConsumeRefusal(ROTATION_FUNDING_NOTE_UNAVAILABLE_ERROR),
      'rotation_funding_note_unavailable'
    ],
    [
      'the rotation claim of a note it cannot prove native',
      new RotationGateConsumeRefusal(ROTATION_FUNDING_NON_NATIVE_ERROR),
      'rotation_funding_not_native'
    ],
    ['any other rotation gate refusal', new RotationGateConsumeRefusal('refused'), 'rotation_gate_refusal']
  ] as const)('names %s as the reason a claim failed at its signing proposal', async (_name, error, reason) => {
    const claim = row({ type: 'consume', stage: 'signing-proposal' });
    await Repo.transactions.put(claim);
    await cancelTransaction(claim, error);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ point: 'pipeline', type: 'consume', stage: 'signing-proposal', reason, error })
    );
  });

  it('names the stuck reaper as the reason a claim failed at its signing proposal', async () => {
    const actual = jest.requireActual<typeof import('lib/telemetry/transaction-failure')>(
      'lib/telemetry/transaction-failure'
    );
    report.mockImplementationOnce(actual.reportTransactionFailure);
    const claim = row({ type: 'consume', stage: 'signing-proposal' });
    await Repo.transactions.put(claim);

    await cancelStuckTransactions();

    expect((await Repo.transactions.get(claim.id))?.status).toBe(ITransactionStatus.Failed);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        point: 'pipeline',
        type: 'consume',
        stage: 'signing-proposal',
        reason: 'stuck_reaped',
        error: TRANSACTION_STUCK_ERROR
      })
    );
    expect(captureCrash).toHaveBeenCalledTimes(1);
    expect(captureCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'WalletTransactionFailure',
        message: expect.stringContaining(
          '; reap age missing_start; reaped attempt not_started_here; submit crossing unavailable; point pipeline; stuck_reaped'
        )
      }),
      'manual',
      expect.anything()
    );
  });

  describe('the startup sweep', () => {
    const accountId = `0x${'ab'.repeat(15)}`;
    const noteId = `0x${'cd'.repeat(32)}`;
    const startupRow = (overrides: Partial<ITransaction>): ITransaction =>
      row({
        id: `tx-${'ef'.repeat(16)}`,
        type: 'consume',
        accountId,
        noteId,
        noteIds: [noteId],
        stage: 'signing-proposal',
        ...overrides
      });

    it.each([
      [
        'a row with no recorded start',
        { processingStartedAt: undefined, stageTimestamps: undefined },
        'missing_start',
        'unavailable',
        'no_submit_recorded'
      ],
      [
        'a row started before this session that recorded a submit',
        {
          processingStartedAt: SESSION_STARTED_AT - 600,
          stageTimestamps: { 'signing-proposal': Date.now() - 5 * 60_000 },
          mayHaveSubmitted: true
        },
        'before_session',
        'under_10m',
        'submit_recorded'
      ],
      [
        'a row stamped further ahead than the clock can explain',
        {
          processingStartedAt: Math.floor(Date.now() / 1000) + MAX_WAIT_BEFORE_CANCEL + 3600,
          stageTimestamps: { 'signing-proposal': Date.now() - 3 * 86_400_000 }
        },
        'future_stamp',
        'over_1d',
        'no_submit_recorded'
      ]
    ] as const)(
      'reports %s with its startup facts and nothing the row holds',
      async (_name, overrides, selection, age, submit) => {
        const actual = jest.requireActual<typeof import('lib/telemetry/transaction-failure')>(
          'lib/telemetry/transaction-failure'
        );
        report.mockImplementationOnce(actual.reportTransactionFailure);
        const claim = startupRow(overrides);
        await Repo.transactions.put(claim);

        await failInterruptedTransactions();

        expect((await Repo.transactions.get(claim.id))?.status).toBe(ITransactionStatus.Failed);
        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'interrupted_on_startup',
            // The row's own facts reach the reporter as read; only the message renders an unknown age as `unavailable`.
            startup: { selection, stageAge: age === 'unavailable' ? undefined : age, submit }
          })
        );
        expect(captureCrash).toHaveBeenCalledTimes(1);
        const [captured] = jest.mocked(captureCrash).mock.calls[0] ?? [];
        const message = captured instanceof Error ? captured.message : '';
        expect(message).toContain(
          `; startup selection ${selection}; stored stage age ${age}; submit ${submit}; submit crossing unavailable; point pipeline; interrupted_on_startup.`
        );
        for (const leak of [accountId, noteId, claim.id, 'abab', 'cdcd', 'efef']) expect(message).not.toContain(leak);
      }
    );

    it('spares a row this realm started and reports nothing for it', async () => {
      const claim = startupRow({ processingStartedAt: undefined });
      await Repo.transactions.put(claim);
      markStartedInThisRealm(claim.id);

      await failInterruptedTransactions();

      expect((await Repo.transactions.get(claim.id))?.status).toBe(ITransactionStatus.GeneratingTransaction);
      expect(report).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['an unconsumed note', 'Committed', 'consume_not_landed'],
    ['a note consumed by a transaction not provably ours', 'ConsumedExternal', 'consume_landed_external']
  ] as const)(
    'names the node check of %s by its own reason and keeps the stored text',
    async (_name, state, reason) => {
      mockNoteDetails.mockResolvedValueOnce([{ state }]);
      const claim = row({
        type: 'consume',
        stage: 'sending',
        noteId: 'n1',
        noteIds: ['n1'],
        processingStartedAt: Math.floor(Date.now() / 1000) - 120
      });
      await Repo.transactions.put(claim);
      await verifyStuckTransactionsFromNode();
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'consume', reason, error: TRANSACTION_INTERRUPTED_ERROR })
      );
      expect(await Repo.transactions.get('tx')).toMatchObject({
        status: ITransactionStatus.Failed,
        error: TRANSACTION_INTERRUPTED_ERROR
      });
    }
  );

  // The debug force-cancel is excluded: no production code calls it.
  it.each(
    [...WALLET_FAILURE_REASONS, ...UNCONFIRMED_FAILURE_REASONS].filter(
      text => text !== TRANSACTION_FORCE_CANCELLED_ERROR
    )
  )('gives the wallet reason "%s" a reported name', async text => {
    await Repo.transactions.put(row());
    await cancelTransaction(row(), text);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0].reason).toEqual(expect.any(String));
  });

  it.each([
    ['cancel', (tx: ITransaction) => cancelTransaction(tx, 'assertion failed')],
    ['status', (tx: ITransaction) => updateTransactionStatus(tx.id, ITransactionStatus.Failed, { error: 'failed' })],
    ['unconfirmed', (tx: ITransaction) => markTransactionUnconfirmed(tx, 'indefinite outcome')]
  ] as const)('forwards what queued a claim from its stored row through %s', async (_name, fail) => {
    await Repo.transactions.put(row({ type: 'consume', consumeEntryPoint: 'claim_all' }));
    await fail(row({ type: 'consume' }));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ type: 'consume', entryPoint: 'claim_all' }));
  });

  it('gives a failure the wallet did not decide no reason', async () => {
    await Repo.transactions.put(row());
    await cancelTransaction(row(), new Error('GUARDIAN HTTP error 409: Conflict'));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0].reason).toBeUndefined();
  });

  it('ignores duplicate cancellation, a status-guard decline and missing rows', async () => {
    await Repo.transactions.put(row());
    await cancelTransaction(row(), 'declined', 'Failed', ITransactionStatus.Queued);
    expect(report).not.toHaveBeenCalled();
    await cancelTransaction(row(), 'first failure');
    await cancelTransaction(row(), 'duplicate');
    await cancelTransaction(row({ id: 'missing' }), 'missing');
    expect(report).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'status'] as const)('does not report when completion races the %s guarded write', async writer => {
    const picked = row();
    await Repo.transactions.put(picked);
    const read = jest.spyOn(Repo.transactions, 'where').mockReturnValueOnce({
      first: async () => {
        await Repo.transactions.update('tx', { status: ITransactionStatus.Completed });
        return picked;
      }
    } as never);
    try {
      const result =
        writer === 'cancel'
          ? await cancelTransaction(picked, 'late failure')
          : await updateTransactionStatus('tx', ITransactionStatus.Failed, {}).catch(error => error.message);
      expect(result).toBe(writer === 'cancel' ? false : 'Transaction already in a finalized state');
      expect((await Repo.transactions.get('tx'))?.status).toBe(ITransactionStatus.Completed);
      expect(report).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('reports the status writer failure once, preferring its raw cause', async () => {
    await Repo.transactions.put(row());
    await updateTransactionStatus('tx', ITransactionStatus.Failed, { error: 'display', rawError: 'raw cause' });
    await expect(updateTransactionStatus('tx', ITransactionStatus.Failed, {})).rejects.toThrow('finalized');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      point: 'pipeline',
      type: 'execute',
      stage: 'proving',
      delegateTransaction: true,
      diagnostics: undefined,
      error: 'raw cause'
    });
  });

  it('emits nothing when the guarded DB write rolls back', async () => {
    await Repo.transactions.put(row());
    const rejectWrite = () => {
      throw new Error('IndexedDB write failed');
    };
    Repo.transactions.hook('updating', rejectWrite);
    try {
      await expect(cancelTransaction(row(), 'execution failed')).rejects.toThrow('IndexedDB write failed');
      expect((await Repo.transactions.get('tx'))?.status).toBe(ITransactionStatus.GeneratingTransaction);
      expect(report).not.toHaveBeenCalled();
    } finally {
      Repo.transactions.hook('updating').unsubscribe(rejectWrite);
    }
  });

  it.each([ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction])(
    'deletes auth diagnostics on an explicitly requested attempt reset to %s',
    async status => {
      const diagnostics = { authPreparation: 'provided', authLayout: 'fee', commitmentMatch: 'neither' } as const;
      await Repo.transactions.put(row({ failureDiagnostics: diagnostics }));
      await updateTransactionStatus('tx', status, { failureDiagnostics: undefined });
      expect(await Repo.transactions.get('tx')).not.toHaveProperty('failureDiagnostics');
      expect(report).not.toHaveBeenCalled();
    }
  );

  it('keeps auth diagnostics when a finalized row declines an attempt reset', async () => {
    const diagnostics = { authPreparation: 'provided', authLayout: 'fee', commitmentMatch: 'neither' } as const;
    await Repo.transactions.put(row({ status: ITransactionStatus.Failed, failureDiagnostics: diagnostics }));
    await expect(
      updateTransactionStatus('tx', ITransactionStatus.Queued, { failureDiagnostics: undefined })
    ).rejects.toThrow('finalized');
    expect((await Repo.transactions.get('tx'))?.failureDiagnostics).toEqual(diagnostics);
  });

  it('keeps auth diagnostics when completion races a requested attempt reset', async () => {
    const diagnostics = { authPreparation: 'provided', authLayout: 'fee', commitmentMatch: 'neither' } as const;
    const picked = row({ failureDiagnostics: diagnostics });
    await Repo.transactions.put(picked);
    const read = jest.spyOn(Repo.transactions, 'where').mockReturnValueOnce({
      first: async () => {
        await Repo.transactions.update('tx', { status: ITransactionStatus.Completed });
        return picked;
      }
    } as never);
    try {
      await expect(
        updateTransactionStatus('tx', ITransactionStatus.Queued, { failureDiagnostics: undefined })
      ).rejects.toThrow('finalized');
      expect((await Repo.transactions.get('tx'))?.failureDiagnostics).toEqual(diagnostics);
      expect(report).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('reports the first unconfirmed transition separately without repeating on evidence updates', async () => {
    const error = new Error('indefinite outcome');
    await Repo.transactions.put(row());
    await markTransactionUnconfirmed(row({ type: 'send', delegateTransaction: false }), error);
    await markTransactionUnconfirmed(row(), error);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      point: 'pipeline',
      type: 'execute',
      stage: 'proving',
      delegateTransaction: true,
      diagnostics: undefined,
      error,
      outcome: 'unconfirmed'
    });
  });

  it.each(['earn-withdraw', 'bridged-receive'] as const)('reports failed %s phases once', async type => {
    await Repo.transactions.put(phased(type, 'delivering'));
    const advance = type === 'earn-withdraw' ? updateEarnWithdrawPhase : updateBridgedReceivePhase;
    await advance('tx', 'failed', { error: 'relay timeout' });
    await advance('tx', 'failed', { error: 'duplicate timeout' });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      point: type === 'earn-withdraw' ? 'earn_settlement' : 'bridge_receive_settlement',
      type,
      stage: 'proving',
      delegateTransaction: true,
      diagnostics: undefined,
      error: 'relay timeout',
      ...(type === 'bridged-receive' ? { bridgeReceive: { route: undefined, step: undefined, cause: undefined } } : {})
    });
  });

  it('reports an inbound bridge becoming failed after ready', async () => {
    await Repo.transactions.put(phased('bridged-receive', 'ready'));
    await updateBridgedReceivePhase('tx', 'failed', { error: 'claim failed' });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("hands an inbound bridge's report its route, the step that failed it and the cause", async () => {
    const cause = new Error('User rejected the request.');
    await Repo.transactions.put(
      row({
        type: 'bridged-receive',
        status: ITransactionStatus.Completed,
        extraInputs: { phase: 'submitting', provider: 'epoch' }
      })
    );

    await updateBridgedReceivePhase('tx', 'failed', {
      error: 'User rejected the request.',
      failure: { step: 'epoch_execute', cause }
    });

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        point: 'bridge_receive_settlement',
        error: 'User rejected the request.',
        bridgeReceive: { route: 'epoch', step: 'epoch_execute', cause }
      })
    );
  });

  it("hands an inbound bridge's report its balance check, orphan check and recorded USDCx route", async () => {
    await Repo.transactions.put(
      row({
        type: 'bridged-receive',
        status: ITransactionStatus.Completed,
        extraInputs: { phase: 'submitting', provider: 'usdcx' }
      })
    );

    await updateBridgedReceivePhase('tx', 'failed', {
      error: 'Bridge submission was interrupted before a transaction hash was recorded.',
      failure: {
        step: 'submission_interrupted',
        balanceCheck: 'read_failed',
        orphanCheck: 'origin_lock',
        sourceRoute: 'cctp_executor'
      }
    });

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeReceive: {
          route: 'usdcx',
          step: 'submission_interrupted',
          balanceCheck: 'read_failed',
          orphanCheck: 'origin_lock',
          sourceRoute: 'cctp_executor'
        }
      })
    );
  });

  describe('ephemeral native request failures', () => {
    const expectedSnapshot: ReownNativeFailure = {
      nativeOrigin: 'wallet_error',
      walletResponseCode: 'internal_error',
      requestAge: '120_to_300s',
      published: 'confirmed',
      backgrounded: 'yes'
    };

    async function nativeApprovalRejection(): Promise<unknown> {
      jest.mocked(Capacitor.getPlatform).mockReturnValue('android');
      const rawError = Object.assign(new Error('Request expired'), {
        code: `REOWN_NATIVE_REQUEST_FAILURE:${JSON.stringify(expectedSnapshot)}`
      });
      jest.mocked(rawReown.sendTransaction).mockRejectedValueOnce(rawError);
      let caught: unknown;
      try {
        await NativeReown.sendTransaction({ chainId: 1, to: `0x${'a1'.repeat(20)}` });
      } catch (rejection) {
        caught = rejection;
      }
      expect(rawReown.sendTransaction).toHaveBeenCalledTimes(1);
      expect(caught).toBe(rawError);
      expect(readReownNativeFailure(caught)).toEqual(expectedSnapshot);
      return caught;
    }

    function expectNoPersistedNativeFailure(value: unknown): void {
      if (typeof value !== 'object' || value === null) return;
      expect(readReownNativeFailure(value)).toBeUndefined();
      expect(Object.getOwnPropertySymbols(value)).toEqual([]);
      for (const [key, nested] of Object.entries(value)) {
        expect([
          'failure',
          'cause',
          ...Object.keys(expectedSnapshot),
          'reownNativeOrigin',
          'reownWalletResponseCode',
          'reownRequestAge',
          'reownPublished',
          'reownBackgrounded'
        ]).not.toContain(key);
        if (typeof nested === 'string') expect(nested).not.toContain('REOWN_NATIVE_REQUEST_FAILURE:');
        expectNoPersistedNativeFailure(nested);
      }
    }

    it('reports the actual marked approval cause once without persisting its snapshot', async () => {
      const caught = await nativeApprovalRejection();
      await Repo.transactions.put(
        row({
          type: 'bridged-receive',
          status: ITransactionStatus.Completed,
          extraInputs: { phase: 'submitting', provider: 'usdcx' }
        })
      );
      const failure = {
        error: 'Request expired',
        failure: { step: 'wallet_approve', cause: caught }
      } satisfies NonNullable<Parameters<typeof updateBridgedReceivePhase>[2]>;
      await updateBridgedReceivePhase('tx', 'failed', failure);
      await updateBridgedReceivePhase('tx', 'failed', failure);

      expect(report).toHaveBeenCalledTimes(1);
      const reported = report.mock.calls[0]?.[0];
      expect(reported).toMatchObject({
        point: 'bridge_receive_settlement',
        type: 'bridged-receive',
        error: 'Request expired',
        bridgeReceive: { route: 'usdcx', step: 'wallet_approve' }
      });
      expect(reported?.bridgeReceive?.cause).toBe(caught);
      expect(readReownNativeFailure(reported?.bridgeReceive?.cause)).toEqual(expectedSnapshot);
      const persisted = await Repo.transactions.get('tx');
      expect(persisted).toMatchObject({
        status: ITransactionStatus.Completed,
        error: 'Request expired',
        extraInputs: { phase: 'failed', provider: 'usdcx', error: 'Request expired' }
      });
      if (persisted === undefined) throw new Error('Expected a persisted inbound bridge');
      expect(persisted.extraInputs).not.toHaveProperty('failure');
      expect(persisted.extraInputs).not.toHaveProperty('cause');
      expect(persisted.extraInputs).not.toHaveProperty('reownNativeOrigin');
      expectNoPersistedNativeFailure(persisted);
    });

    it('does not report or persist a marked failure on a restored inbound bridge', async () => {
      const caught = await nativeApprovalRejection();
      await Repo.transactions.put(
        row({
          type: 'bridged-receive',
          status: ITransactionStatus.Completed,
          restoredFromBackup: true,
          extraInputs: { phase: 'submitting', provider: 'usdcx' }
        })
      );
      const failure = {
        error: 'Request expired',
        failure: { step: 'wallet_approve', cause: caught }
      } satisfies NonNullable<Parameters<typeof updateBridgedReceivePhase>[2]>;
      await updateBridgedReceivePhase('tx', 'failed', failure);
      await updateBridgedReceivePhase('tx', 'failed', failure);

      const persisted = await Repo.transactions.get('tx');
      expect(persisted).toMatchObject({
        restoredFromBackup: true,
        error: 'Request expired',
        extraInputs: { phase: 'failed', provider: 'usdcx', error: 'Request expired' }
      });
      if (persisted === undefined) throw new Error('Expected a persisted restored inbound bridge');
      expectNoPersistedNativeFailure(persisted);
      expect(report).not.toHaveBeenCalled();
    });
  });

  it('fails a restored inbound bridge the reconciler cannot verify without reporting it', async () => {
    await Repo.transactions.put(
      row({
        type: 'bridged-receive',
        status: ITransactionStatus.Completed,
        restoredFromBackup: true,
        extraInputs: { phase: 'submitting', provider: 'usdcx' }
      })
    );

    await updateBridgedReceivePhase('tx', 'failed', { error: 'delivery could not be verified' });

    expect(await Repo.transactions.get('tx')).toMatchObject({
      error: 'delivery could not be verified',
      extraInputs: { phase: 'failed', provider: 'usdcx' }
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('reports outbound bridge demotion once even after the note completed', async () => {
    await Repo.transactions.put(row({ type: 'bridged-send', status: ITransactionStatus.Completed }));
    await markBridgedSendFailed('tx', 'no route liquidity');
    await markBridgedSendFailed('tx', 'duplicate');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      point: 'bridge_send_settlement',
      type: 'bridged-send',
      stage: 'proving',
      delegateTransaction: true,
      diagnostics: undefined,
      error: 'no route liquidity'
    });
  });

  it.each([
    [
      'a discarded Guardian switch',
      () =>
        row({
          type: 'switch-guardian',
          status: ITransactionStatus.Completed,
          extraInputs: { commitUnconfirmed: true },
          lastDeferral: 'guardian_unreachable'
        }),
      () => resolveUnconfirmedSwitch('tx', false)
    ],
    [
      'a demoted outbound bridge',
      () => row({ type: 'bridged-send', status: ITransactionStatus.Completed, lastDeferral: 'guardian_unreachable' }),
      () => markBridgedSendFailed('tx', 'no route liquidity')
    ],
    [
      'a failed Earn withdrawal',
      () => ({ ...phased('earn-withdraw', 'delivering'), lastDeferral: 'guardian_unreachable' as const }),
      () => updateEarnWithdrawPhase('tx', 'failed', { error: 'relay timeout' })
    ],
    [
      'a failed inbound bridge',
      () => ({ ...phased('bridged-receive', 'delivering'), lastDeferral: 'guardian_unreachable' as const }),
      () => updateBridgedReceivePhase('tx', 'failed', { error: 'relay timeout' })
    ]
  ])("forwards the row's recorded last deferral when reporting %s", async (_name, stored, fail) => {
    await Repo.transactions.put(stored());
    await fail();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ lastDeferral: 'guardian_unreachable' }));
  });

  it('reports a discarded Guardian switch once, but never a landed switch', async () => {
    await Repo.transactions.put(
      row({ type: 'switch-guardian', status: ITransactionStatus.Completed, extraInputs: { commitUnconfirmed: true } })
    );
    await resolveUnconfirmedSwitch('tx', false);
    await resolveUnconfirmedSwitch('tx', false);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        point: 'guardian_node_verdict',
        type: 'switch-guardian',
        reason: 'never_committed',
        error: 'The node discarded this guardian switch after submission.'
      })
    );
    report.mockClear();
    await resolveUnconfirmedSwitch('tx', true);
    expect(report).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: 'switch-guardian' as const,
      status: ITransactionStatus.Completed,
      extraInputs: { commitUnconfirmed: false }
    },
    {
      type: 'switch-guardian' as const,
      status: ITransactionStatus.GeneratingTransaction,
      extraInputs: { commitUnconfirmed: true }
    },
    { type: 'send' as const, status: ITransactionStatus.Completed, extraInputs: { commitUnconfirmed: true } }
  ])('does not demote a Guardian resolution outside the pending switch state: %j', async overrides => {
    const tx = row(overrides);
    await Repo.transactions.put(tx);
    await resolveUnconfirmedSwitch('tx', false);
    expect(await Repo.transactions.get('tx')).toEqual(tx);
    expect(report).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel', (tx: ITransaction) => cancelTransaction(tx, 'historical')],
    [
      'status',
      (tx: ITransaction) => updateTransactionStatus(tx.id, ITransactionStatus.Failed, { error: 'historical' })
    ],
    ['unconfirmed', (tx: ITransaction) => markTransactionUnconfirmed(tx, 'historical')],
    ['withdraw', (tx: ITransaction) => updateEarnWithdrawPhase(tx.id, 'failed', { error: 'historical' })],
    ['inbound bridge', (tx: ITransaction) => updateBridgedReceivePhase(tx.id, 'failed', { error: 'historical' })],
    ['outbound bridge', (tx: ITransaction) => markBridgedSendFailed(tx.id, 'historical')],
    ['Guardian switch', (tx: ITransaction) => resolveUnconfirmedSwitch(tx.id, false)]
  ] as const)('does not replay imported backup failures through %s', async (_name, fail) => {
    const tx = row({ restoredFromBackup: true, extraInputs: { phase: 'delivering' } });
    await Repo.transactions.put(tx);
    await fail(tx);
    expect(report).not.toHaveBeenCalled();
  });

  it('never reports imported backup failures or successful transitions', async () => {
    await Repo.transactions.put(row({ restoredFromBackup: true }));
    await cancelTransaction(row(), 'historical failure');
    await Repo.transactions.put(phased('earn-withdraw', 'delivering'));
    await updateEarnWithdrawPhase('tx', 'received');
    expect(report).not.toHaveBeenCalled();
  });
});

describe('closed queue facts without failure text', () => {
  const accountId = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
  const commitment = `0x${'ab'.repeat(32)}`;
  const amount = '1234567';
  const privateText = [accountId, commitment, amount];
  const error = new Error(`Claim failed for account ${accountId}, commitment ${commitment}, amount ${amount}`);

  const useRealReporterWithPrivateError = () => {
    const actual = jest.requireActual<typeof import('lib/telemetry/transaction-failure')>(
      'lib/telemetry/transaction-failure'
    );
    report.mockImplementationOnce(failure => actual.reportTransactionFailure({ ...failure, error }));
  };

  const capturedFailure = () => {
    const calls = jest.mocked(captureCrash).mock.calls;
    expect(calls).toHaveLength(1);
    const failure = calls[0]![0];
    if (!(failure instanceof Error)) throw new Error('Expected a transaction failure Error');
    expect(failure.name).toBe('WalletTransactionFailure');
    const strings = JSON.stringify(calls, (_key: string, value: unknown): unknown =>
      value instanceof Error
        ? { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause }
        : value
    );
    return { message: failure.message, strings };
  };

  it("sends the claim's fixed queue facts and none of the failure's text", async () => {
    useRealReporterWithPrivateError();
    const claim = row({
      id: 'queue-facts-expired-claim',
      type: 'consume',
      accountId,
      status: ITransactionStatus.Queued,
      initiatedAt: SESSION_STARTED_AT - MAX_QUEUED_AGE - 60,
      stage: 'syncing',
      consumeEntryPoint: undefined,
      lastDeferral: 'wallet_locked',
      feeAdmission: 'balance_unknown'
    });
    await Repo.transactions.put(claim);

    await cancelStaleQueuedTransactions();

    expect((await Repo.transactions.get(claim.id))?.status).toBe(ITransactionStatus.Failed);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'consume',
        reason: 'queued_expired',
        queueAge: '30m_to_1h',
        queueSighting: 'never',
        preflightSync: 'not_entered',
        queueHidden: 'not_measured',
        error: TRANSACTION_EXPIRED_ERROR
      })
    );
    const { message, strings } = capturedFailure();
    expect(message).toContain(
      '; queued by unrecorded; last deferral wallet_locked; claim fee admission balance_unknown; queue age 30m_to_1h; queue sighting never; sync attempt not_entered; queue hidden not_measured; submit crossing unavailable; point pipeline;'
    );
    expect(message).toContain('; point pipeline; queued_expired.');
    expect(message).toContain(
      '; queue age 30m_to_1h; queue sighting never; sync attempt not_entered; queue hidden not_measured; submit crossing unavailable; point pipeline; queued_expired.'
    );
    for (const text of privateText) {
      expect(message).not.toContain(text);
      expect(strings).not.toContain(text);
    }
    expect(message).not.toContain(String(claim.initiatedAt));
    expect(strings).not.toContain(String(claim.initiatedAt));
  });

  it('does not expire a row at exactly the queue TTL', async () => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    try {
      const claim = row({
        id: 'queue-facts-exact-ttl',
        type: 'consume',
        status: ITransactionStatus.Queued,
        initiatedAt: Math.floor(nowMs / 1000) - MAX_QUEUED_AGE
      });
      await Repo.transactions.put(claim);

      await cancelStaleQueuedTransactions();

      expect((await Repo.transactions.get(claim.id))?.status).toBe(ITransactionStatus.Queued);
      expect(report).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['just past the 30-minute TTL', MAX_QUEUED_AGE + 1, '30m_to_1h'],
    ['just below one hour', 60 * 60 - 1, '30m_to_1h'],
    ['at one hour', 60 * 60, '1h_to_6h'],
    ['just below six hours', 6 * 60 * 60 - 1, '1h_to_6h'],
    ['at six hours', 6 * 60 * 60, '6h_to_24h'],
    ['just below one day', 24 * 60 * 60 - 1, '6h_to_24h'],
    ['at one day', 24 * 60 * 60, 'over_24h']
  ] as const)('buckets an expired row %s', async (_label, ageSeconds, expectedAge) => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    useRealReporterWithPrivateError();
    try {
      const claim = row({
        id: `queue-facts-${expectedAge}`,
        type: 'consume',
        status: ITransactionStatus.Queued,
        initiatedAt: Math.floor(nowMs / 1000) - ageSeconds
      });
      await Repo.transactions.put(claim);

      await cancelStaleQueuedTransactions();

      expect((await Repo.transactions.get(claim.id))?.status).toBe(ITransactionStatus.Failed);
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: 'queued_expired', queueAge: expectedAge }));
      const { message } = capturedFailure();
      expect(message).toContain(
        `; queue age ${expectedAge}; queue sighting never; sync attempt not_entered; queue hidden not_measured; submit crossing unavailable; point pipeline; queued_expired.`
      );
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['missing', () => undefined],
    ['NaN', () => Number.NaN],
    ['infinite', () => Number.POSITIVE_INFINITY],
    ['negative', () => -1],
    ['in the future', (nowSeconds: number) => nowSeconds + 1]
  ] as const)('reports an unavailable queue age for a %s start time', async (_label, makeInitiatedAt) => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    useRealReporterWithPrivateError();
    try {
      const claim = row({
        id: `queue-facts-invalid-${_label}`,
        type: 'consume',
        status: ITransactionStatus.Queued,
        initiatedAt: makeInitiatedAt(Math.floor(nowMs / 1000)) as number
      });
      await Repo.transactions.put(claim);

      await cancelTransaction(claim, TRANSACTION_EXPIRED_ERROR);

      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'queued_expired', queueAge: 'unavailable' })
      );
      const { message, strings } = capturedFailure();
      expect(message).toContain(
        '; queue age unavailable; queue sighting never; sync attempt not_entered; queue hidden not_measured; submit crossing unavailable; point pipeline; queued_expired.'
      );
      expect(message).not.toContain(String(claim.id));
      expect(strings).not.toContain(String(claim.id));
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['stage marker', { source: 'stage' }, 'crossed'],
    ['captured submit evidence after a pre-dispatch pin', { source: 'pin', refBlock: 9 }, 'crossed'],
    ['explicit pre-submit end', { source: 'pin', preSubmitEnd: true }, 'not_crossed'],
    ['ambiguous pin', { source: 'pin' }, 'unavailable'],
    ['missing current attempt', undefined, 'unavailable']
  ] as const)(
    'reports the matching attempt submit crossing from %s',
    async (_label, currentEntry, expectedCrossing) => {
      useRealReporterWithPrivateError();
      const priorAttemptId = 'private-prior-attempt-id';
      const currentAttemptId = currentEntry === undefined ? 'private-missing-attempt-id' : 'private-current-attempt-id';
      const transactionId = `0x${'cd'.repeat(32)}`;
      const capturedAt = 1_790_000_000;
      const claim = row({
        id: 'private-transaction-row-id',
        attemptId: currentAttemptId,
        submitEvidence: [
          { attemptId: priorAttemptId, capturedAt, source: 'stage', transactionId },
          ...(currentEntry === undefined
            ? []
            : [{ attemptId: 'private-current-attempt-id', capturedAt, ...currentEntry }])
        ]
      });
      await Repo.transactions.put(claim);

      await cancelTransaction(claim, error);

      expect(report).toHaveBeenCalledWith(expect.objectContaining({ submitCrossing: expectedCrossing }));
      const { message, strings } = capturedFailure();
      expect(message).toContain(`; submit crossing ${expectedCrossing}; point pipeline;`);
      for (const text of [
        ...privateText,
        claim.id,
        priorAttemptId,
        currentAttemptId,
        transactionId,
        String(capturedAt),
        error.message
      ]) {
        expect(message).not.toContain(text);
        expect(strings).not.toContain(text);
      }
    }
  );

  it("sends the stuck claim's fixed reap facts and none of the failure's text", async () => {
    useRealReporterWithPrivateError();
    const claim = row({
      id: 'queue-facts-stuck-claim',
      type: 'consume',
      accountId,
      stage: 'signing-proposal',
      processingStartedAt: SESSION_STARTED_AT,
      consumeEntryPoint: undefined,
      lastDeferral: 'wallet_locked',
      feeAdmission: 'balance_unknown'
    });
    await Repo.transactions.put(claim);
    markStartedInThisRealm(claim.id);
    const clock = jest.spyOn(Date, 'now').mockReturnValue((SESSION_STARTED_AT + MAX_WAIT_BEFORE_CANCEL + 1) * 1000);
    try {
      await cancelStuckTransactions();

      expect((await Repo.transactions.get(claim.id))?.status).toBe(ITransactionStatus.Failed);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'consume',
          reason: 'stuck_reaped',
          reap: { age: 'past_limit', attempt: 'started_here', startRelation: 'at_or_after_realm_cutoff' },
          error: TRANSACTION_STUCK_ERROR
        })
      );
      const { message, strings } = capturedFailure();
      expect(message).toContain(
        '; queued by unrecorded; last deferral wallet_locked; claim fee admission balance_unknown; reap age'
      );
      expect(message).toContain(
        '; reap age past_limit; reaped attempt started_here; submit crossing unavailable; point pipeline; stuck_reaped.'
      );
      for (const text of privateText) {
        expect(message).not.toContain(text);
        expect(strings).not.toContain(text);
      }
    } finally {
      clock.mockRestore();
    }
  });
});

it('binds the selected stuck start to the committed cancellation report', async () => {
  await Repo.transactions.put(row({ processingStartedAt: SESSION_STARTED_AT - 3600 }));
  await cancelStuckTransactions();
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: 'stuck_reaped',
      reap: expect.objectContaining({ startRelation: 'before_realm_cutoff' })
    })
  );
});

it('publishes only the already queried surviving queue membership after reaping', async () => {
  const member = row({ status: ITransactionStatus.Queued, initiatedAt: Math.floor(Date.now() / 1000), queuedSeq: 7 });
  await Repo.transactions.put(member);
  const observed = jest.fn();
  await Reflect.apply(cancelStaleQueuedTransactions, undefined, [observed]);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(observed).toHaveBeenCalledWith([
    expect.objectContaining({ id: member.id, initiatedAt: member.initiatedAt, queuedSeq: 7 })
  ]);
  expect(report).not.toHaveBeenCalled();
});

it.each([false, true])('uses only earlier exact gate membership at committed expiry (changed=%s)', async changed => {
  pruneQueueAdmission([]);
  const now = Math.floor(Date.now() / 1000);
  const waiting = row({ id: 'queue-member', status: ITransactionStatus.Queued, initiatedAt: now, queuedSeq: 1 });
  await Repo.transactions.put(waiting);
  await Repo.transactions.put(row({ id: 'active', processingStartedAt: now }));
  const queries = jest.spyOn(Repo.transactions, 'filter');
  try {
    await generateTransactionsLoop(async () => new Uint8Array(), false, {
      getAccounts: async () => [],
      getPublicKeyForCommitment: async () => '',
      signWord: async () => ''
    });
    expect(consumeQueueAdmission({ ...waiting, id: 'missing-member' })).toBe('unavailable');
    if (changed) await Repo.transactions.update(waiting.id, { queuedSeq: 2 });
    const clock = jest.spyOn(Date, 'now').mockReturnValue((now + MAX_QUEUED_AGE + 1) * 1000);
    try {
      await cancelStaleQueuedTransactions();
    } finally {
      clock.mockRestore();
    }
    expect(queries).toHaveBeenCalledTimes(4);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'queued_expired',
        queueAdmissionObservation: changed ? 'unavailable' : 'in_progress_gate',
        queueSighting: changed ? 'never' : 'in_progress_gate',
        preflightSync: 'not_entered',
        queueHidden: 'not_measured'
      })
    );
    expect(consumeQueueAdmission(changed ? { ...waiting, queuedSeq: 2 } : waiting)).toBe('unavailable');
  } finally {
    queries.mockRestore();
  }
});

it('cleans restored terminal queue history without reporting it', async () => {
  const waiting = row({
    status: ITransactionStatus.Queued,
    initiatedAt: Math.floor(Date.now() / 1000) - MAX_QUEUED_AGE - 1,
    restoredFromBackup: true
  });
  recordQueueAdmission(waiting, 'selected');
  await Repo.transactions.put(waiting);
  await cancelStaleQueuedTransactions();
  expect(report).not.toHaveBeenCalled();
  expect(consumeQueueAdmission(waiting)).toBe('unavailable');
});
