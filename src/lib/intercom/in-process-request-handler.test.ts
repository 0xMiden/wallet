/**
 * The ONE switch both in-process adapters (mobile, desktop) dispatch through.
 * These tests pin the cases that have no service worker behind them — a case
 * missing HERE falls through to `default:` and returns `undefined`, which every
 * store wrapper then dereferences (the exact drift this module exists to end).
 */

import { WalletMessageType, WalletRequest } from 'lib/shared/types';

import { processInProcessRequest } from './in-process-request-handler';

const mockRetryDeadletteredNotes = jest.fn(async () => ({ requeued: 3 }));
const mockScanForAccounts = jest.fn(async (_count: number, _endpoint?: string) => [{ publicKey: 'pk-new' }]);
jest.mock('lib/miden/back/actions', () => ({
  retryDeadletteredNotes: () => mockRetryDeadletteredNotes(),
  scanForAccounts: (count: number, endpoint?: string) => mockScanForAccounts(count, endpoint)
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

  // The recovered-accounts overview's "I have more accounts" runs on
  // mobile/desktop through this same switch.
  it('ScanForAccountsRequest runs the scan action and returns the found accounts', async () => {
    const res = await processInProcessRequest(
      {
        type: WalletMessageType.ScanForAccountsRequest,
        additionalCount: 5,
        guardianEndpoint: 'https://guardian.example'
      } as WalletRequest,
      'test-adapter'
    );

    expect(res).toEqual({ type: WalletMessageType.ScanForAccountsResponse, found: [{ publicKey: 'pk-new' }] });
    expect(mockScanForAccounts).toHaveBeenCalledWith(5, 'https://guardian.example');
  });
});
