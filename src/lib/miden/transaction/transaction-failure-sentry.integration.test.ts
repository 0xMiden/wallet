import * as Repo from 'lib/miden/repo';

import { cancelTransaction, markTransactionUnconfirmed, verifyStuckTransactionsFromNode } from './cancel';
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
import { ITransaction, ITransactionStatus } from '../db/types';

jest.mock('lib/telemetry/transaction-failure', () => ({ reportTransactionFailure: jest.fn() }));
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

const report = jest.requireMock('lib/telemetry/transaction-failure').reportTransactionFailure as jest.Mock;
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
      error
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
      error: 'failed'
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
    ['the stuck reaper', TRANSACTION_STUCK_ERROR, 'stuck_reaped'],
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
