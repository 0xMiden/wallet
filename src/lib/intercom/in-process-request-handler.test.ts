/**
 * The ONE switch both in-process adapters (mobile, desktop) dispatch through.
 * These tests pin the cases that have no service worker behind them — a case
 * missing HERE falls through to `default:` and returns `undefined`, which every
 * store wrapper then dereferences (the exact drift this module exists to end).
 */

const mockRetryDeadletteredNotes = jest.fn(async () => ({ requeued: 3 }));
jest.mock('lib/miden/back/actions', () => ({
  retryDeadletteredNotes: () => mockRetryDeadletteredNotes()
}));

import { WalletMessageType, WalletRequest } from 'lib/shared/types';

import { processInProcessRequest } from './in-process-request-handler';

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
});
