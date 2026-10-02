// Light mocks so importing cancel.ts doesn't pull in Dexie / the WASM client proxy.
import { GuardianSwitchDiscardedError, GuardianWriteDiscardedError } from 'lib/miden/guardian/direct-switch';

import { cancelTransaction, isTransactionStuck } from './cancel';
import { TRANSACTION_STUCK_ERROR, USER_CANCELLED_TRANSACTION_REASON } from './constants';
import {
  notifyBackgroundTransactionFailed,
  notifyBackgroundTransactionNotConfirmed
} from '../back/background-notification';
import { ITransactionStatus, Transaction } from '../db/types';

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
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn(),
  showBackgroundNotification: jest.fn()
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => true) }));
jest.mock('lib/mobile/background-time', () => ({
  ...jest.requireActual('lib/mobile/background-time'),
  hiddenSecondsSince: jest.fn(() => 0)
}));
jest.mock('./get', () => ({ getTransactionsInProgress: jest.fn() }));
jest.mock('./helper', () => ({ updateTransactionStatus: jest.fn() }));
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
