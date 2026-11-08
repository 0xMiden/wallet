import { ITransactionStatus } from 'lib/miden/db/types';

import { epochReturnDisplay } from './useEpochReturnState';

jest.mock('lib/epoch/return-state', () => ({ readEpochNoteState: jest.fn() }));
jest.mock('lib/miden/repo', () => ({ transactions: {} }));

it('uses neutral recovery states for verified unspent notes', () => {
  expect(epochReturnDisplay('waiting', [])).toEqual({ status: 'awaitingReturn', messageKey: 'epochReturnWaiting' });
  expect(epochReturnDisplay('ready', [])).toEqual({ status: 'readyToClaim', messageKey: 'epochReturnReady' });
});
it('does not promise a return for a missing note or a failed read', () => {
  expect(epochReturnDisplay('absent', []).status).toBeUndefined();
  expect(epochReturnDisplay(undefined, []).status).toBeUndefined();
});
it('shows the Epoch payout when the note was consumed', () => {
  expect(epochReturnDisplay('spent', []).status).toBe('confirmed');
});
it('distinguishes a wallet return from an Epoch payout', () => {
  expect(epochReturnDisplay('spent', [{ status: ITransactionStatus.Completed }]).status).toBe('fundsReturned');
  expect(epochReturnDisplay('spent', [{ status: ITransactionStatus.GeneratingTransaction }]).status).toBe(
    'returningFunds'
  );
});
it('allows another claim after a return claim fails', () => {
  expect(epochReturnDisplay('ready', [{ status: ITransactionStatus.Failed }]).status).toBe('readyToClaim');
});
