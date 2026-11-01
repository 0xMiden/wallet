/**
 * The ONE switch both in-process adapters (mobile, desktop) dispatch through.
 * These tests pin the cases that have no service worker behind them — a case
 * missing HERE falls through to `default:` and returns `undefined`, which every
 * store wrapper then dereferences (the exact drift this module exists to end).
 */

import {
  type BackupDeleteProfileRequest,
  type BackupRefreshOutcome,
  type BackupRefreshReason,
  type BackupRefreshRequest,
  WalletMessageType,
  WalletRequest
} from 'lib/shared/types';

import { processInProcessRequest } from './in-process-request-handler';

const mockRefreshBackup = jest.fn(async (_reason: BackupRefreshReason): Promise<BackupRefreshOutcome> => 'updated');
const mockDeleteBackup = jest.fn(async (): Promise<BackupRefreshOutcome> => 'unchanged');

const mockRetryDeadletteredNotes = jest.fn(async () => ({ requeued: 3 }));
const mockExportAccountFile = jest.fn(async (_accountPublicKey: string, _password?: string) => 'BAUG');
const mockUnlock = jest.fn(async (_password: string) => undefined);
const mockEstimateUsdcxBurnFee = jest.fn(async (_req: unknown) => ({
  type: WalletMessageType.EstimateUsdcxBurnFeeResponse,
  outcome: 'measured',
  feeReserve: '315'
}));
jest.mock('lib/miden/back/actions', () => ({
  estimateUsdcxBurnFee: (req: unknown) => mockEstimateUsdcxBurnFee(req),
  retryDeadletteredNotes: () => mockRetryDeadletteredNotes(),
  exportAccountFile: (...args: unknown[]) => mockExportAccountFile(...(args as [string, string | undefined])),
  unlock: (password: string) => mockUnlock(password),
  refreshBackup: (reason: BackupRefreshReason) => mockRefreshBackup(reason),
  deleteBackup: () => mockDeleteBackup()
}));
const mockStartTransactionProcessing = jest.fn(async () => undefined);
jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: () => mockStartTransactionProcessing()
}));

describe('processInProcessRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // #788 follow-up: the dead-letter drain must work on mobile/desktop, where
  // the import pass runs in the single shared realm.
  it('RetryDeadletteredNotesRequest runs the drain action and reports the requeued count', async () => {
    const res = await processInProcessRequest(
      { type: WalletMessageType.RetryDeadletteredNotesRequest } as WalletRequest,
      'test-adapter'
    );

    expect(res).toEqual({ type: WalletMessageType.RetryDeadletteredNotesResponse, requeued: 3 });
    expect(mockRetryDeadletteredNotes).toHaveBeenCalledTimes(1);
  });

  it('ExportAccountFileRequest forwards authentication and returns the base64 file', async () => {
    const res = await processInProcessRequest(
      {
        type: WalletMessageType.ExportAccountFileRequest,
        accountPublicKey: 'mtst1account',
        password: 'pw'
      } as WalletRequest,
      'test-adapter'
    );

    expect(res).toEqual({ type: WalletMessageType.ExportAccountFileResponse, accountFileBase64: 'BAUG' });
    expect(mockExportAccountFile).toHaveBeenCalledWith('mtst1account', 'pw');
  });

  it('EstimateUsdcxBurnFeeRequest reaches the estimate action and answers its response', async () => {
    const req = {
      type: WalletMessageType.EstimateUsdcxBurnFeeRequest,
      accountPublicKey: 'mm1account',
      destinationChainId: 5042002
    } as WalletRequest;

    const res = await processInProcessRequest(req, 'test-adapter');

    expect(res).toEqual({
      type: WalletMessageType.EstimateUsdcxBurnFeeResponse,
      outcome: 'measured',
      feeReserve: '315'
    });
    expect(mockEstimateUsdcxBurnFee).toHaveBeenCalledWith(req);
  });

  // #1202: claims requeued while the vault was locked have nothing else to restart them off the extension.
  it('UnlockRequest kicks transaction processing once the vault has unlocked', async () => {
    const res = await processInProcessRequest(
      { type: WalletMessageType.UnlockRequest, password: 'pw' } as WalletRequest,
      'test-adapter'
    );

    expect(res).toEqual({ type: WalletMessageType.UnlockResponse });
    expect(mockUnlock).toHaveBeenCalledWith('pw');
    expect(mockStartTransactionProcessing).toHaveBeenCalledTimes(1);
  });

  it('UnlockRequest answers without waiting for the processing it kicks', async () => {
    mockStartTransactionProcessing.mockImplementationOnce(() => new Promise<undefined>(() => {}));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timed out'>(resolve => {
      timer = setTimeout(() => resolve('timed out'), 1000);
    });
    try {
      const res = await Promise.race([
        processInProcessRequest(
          { type: WalletMessageType.UnlockRequest, password: 'pw' } as WalletRequest,
          'test-adapter'
        ),
        timedOut
      ]);
      expect(res).toEqual({ type: WalletMessageType.UnlockResponse });
    } finally {
      clearTimeout(timer);
    }
    expect(mockStartTransactionProcessing).toHaveBeenCalledTimes(1);
  });

  // The encrypted backup runs in this realm on mobile and desktop, so both backup messages need a case here.
  it('BackupRefreshRequest runs the refresh of the named event and answers its outcome', async () => {
    const req: BackupRefreshRequest = { type: WalletMessageType.BackupRefreshRequest, reason: 'foreground' };

    const res = await processInProcessRequest(req, 'test-adapter');

    expect(res).toEqual({ type: WalletMessageType.BackupRefreshResponse, outcome: 'updated' });
    expect(mockRefreshBackup).toHaveBeenCalledWith('foreground');
    expect(mockDeleteBackup).not.toHaveBeenCalled();
  });

  it('BackupDeleteProfileRequest deletes the backup profile and answers its outcome', async () => {
    const req: BackupDeleteProfileRequest = { type: WalletMessageType.BackupDeleteProfileRequest };

    const res = await processInProcessRequest(req, 'test-adapter');

    expect(res).toEqual({ type: WalletMessageType.BackupDeleteProfileResponse, outcome: 'unchanged' });
    expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
    expect(mockRefreshBackup).not.toHaveBeenCalled();
  });

  it('a failed unlock does not kick transaction processing', async () => {
    mockUnlock.mockRejectedValueOnce(new Error('Invalid password'));
    await expect(
      processInProcessRequest(
        { type: WalletMessageType.UnlockRequest, password: 'wrong' } as WalletRequest,
        'test-adapter'
      )
    ).rejects.toThrow('Invalid password');
    expect(mockStartTransactionProcessing).not.toHaveBeenCalled();
  });
});
