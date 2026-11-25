/**
 * The ONE switch both in-process adapters (mobile, desktop) dispatch through.
 * These tests pin the cases that have no service worker behind them — a case
 * missing HERE falls through to `default:` and returns `undefined`, which every
 * store wrapper then dereferences (the exact drift this module exists to end).
 */

import type { RelayDepositStatus, RelayDepositTarget } from 'lib/evm-relay/deposit';
import {
  type BackupDeleteProfileRequest,
  type BackupRefreshOutcome,
  type BackupRefreshReason,
  type BackupRefreshRequest,
  type RelaySignRequest,
  type RelaySignResult,
  type SignEvmRequest,
  WalletMessageType,
  WalletRequest
} from 'lib/shared/types';

import { processInProcessRequest } from './in-process-request-handler';

const RELAY_RESULT: RelaySignResult = { op: 'batch', digest: `0x${'11'.repeat(32)}`, signature: '0x22' };
const TICK_STATUS: RelayDepositStatus = { kind: 'bridging', rowId: 'row-1' };

const mockRefreshBackup = jest.fn(async (_reason: BackupRefreshReason): Promise<BackupRefreshOutcome> => 'updated');
const mockDeleteBackup = jest.fn(async (): Promise<BackupRefreshOutcome> => 'unchanged');

const mockRetryDeadletteredNotes = jest.fn(async () => ({ requeued: 3 }));
const mockExportAccountFile = jest.fn(async (_accountPublicKey: string, _password?: string) => 'BAUG');
const mockUnlock = jest.fn(async (_password: string) => undefined);
const mockEstimateUsdcxBurnFee = jest.fn(async (_req: unknown) => ({
  type: WalletMessageType.EstimateUsdcxBurnFeeResponse,
  outcome: 'measured',
  feeReserve: '315',
  faucetId: 'native',
  scope: 'source-scope'
}));
const mockSignEvm = jest.fn(async (..._args: unknown[]) => '0xsigned');
const mockSignRelay = jest.fn(async (_accountPublicKey: string, _request: RelaySignRequest) => RELAY_RESULT);
const mockRelayDepositTick = jest.fn(
  async (_accountPublicKey: string, _target: RelayDepositTarget): Promise<RelayDepositStatus> => TICK_STATUS
);
jest.mock('lib/miden/back/actions', () => ({
  signEvm: (...args: unknown[]) => mockSignEvm(...args),
  signRelay: (accountPublicKey: string, request: RelaySignRequest) => mockSignRelay(accountPublicKey, request),
  relayDepositTick: (accountPublicKey: string, target: RelayDepositTarget) =>
    mockRelayDepositTick(accountPublicKey, target),
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

  it.each(['MobileIntercomAdapter', 'DesktopIntercomAdapter'])(
    'keeps platform credentials unavailable on %s',
    async label => {
      await expect(
        processInProcessRequest({ type: WalletMessageType.PlatformUnlockRequest, command: { action: 'state' } }, label)
      ).rejects.toThrow();
    }
  );

  it('does not treat an extension reset nonce as native reset authority', async () => {
    await expect(
      processInProcessRequest(
        { type: WalletMessageType.PlatformResetRequest, nonce: 'A'.repeat(43) },
        'DesktopIntercomAdapter'
      )
    ).rejects.toThrow();
  });

  it('SignRelayRequest runs the relay sign action and returns its result', async () => {
    const request: RelaySignRequest = { op: 'authorization', chainId: 11155111, nonce: 0 };
    const res = await processInProcessRequest(
      { type: WalletMessageType.SignRelayRequest, accountPublicKey: 'pk1', request },
      'test-adapter'
    );

    expect(res).toEqual({ type: WalletMessageType.SignRelayResponse, result: RELAY_RESULT });
    expect(mockSignRelay).toHaveBeenCalledWith('pk1', request);
  });

  it('RelayDepositTickRequest runs one deposit tick and returns its status', async () => {
    const target: RelayDepositTarget = { provider: 'agglayer', chainId: 8453, token: `0x${'00'.repeat(20)}` };
    const res = await processInProcessRequest(
      { type: WalletMessageType.RelayDepositTickRequest, accountPublicKey: 'pk1', target },
      'test-adapter'
    );

    expect(res).toEqual({ type: WalletMessageType.RelayDepositTickResponse, status: TICK_STATUS });
    expect(mockRelayDepositTick).toHaveBeenCalledWith('pk1', target);
  });

  it('SignEvmRequest never passes a key role on, so the relay key cannot sign a generic payload', async () => {
    const request: SignEvmRequest = {
      type: WalletMessageType.SignEvmRequest,
      accountPublicKey: 'pk1',
      operation: { op: 'typed-data', digest: `0x${'11'.repeat(32)}` }
    };
    // A request from an older frontend, or a hostile one, can still carry the removed field.
    await processInProcessRequest(Object.assign({}, request, { key: 'relay' }), 'test-adapter');

    expect(mockSignEvm).toHaveBeenCalledTimes(1);
    expect(mockSignEvm.mock.calls[0]).toEqual(['pk1', request.operation]);
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
      feeReserve: '315',
      faucetId: 'native',
      scope: 'source-scope'
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
