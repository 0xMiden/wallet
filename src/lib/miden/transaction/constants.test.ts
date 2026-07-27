import {
  formatRawTransactionError,
  isUserCancelledTransaction,
  REMOTE_PROVER_FAILED_ERROR,
  resolveTransactionErrorMessage,
  USER_CANCELLED_TRANSACTION_REASON
} from './constants';

describe('isUserCancelledTransaction', () => {
  it('matches only the exact user-cancellation reason', () => {
    expect(isUserCancelledTransaction(USER_CANCELLED_TRANSACTION_REASON)).toBe(true);
    expect(isUserCancelledTransaction('something else')).toBe(false);
    expect(isUserCancelledTransaction(new Error(USER_CANCELLED_TRANSACTION_REASON))).toBe(false);
    expect(isUserCancelledTransaction(undefined)).toBe(false);
  });
});

describe('formatRawTransactionError', () => {
  it('formats Errors as `name: message` and stringifies everything else', () => {
    expect(formatRawTransactionError(new Error('boom'))).toBe('Error: boom');
    expect(formatRawTransactionError(new TypeError('bad type'))).toBe('TypeError: bad type');
    expect(formatRawTransactionError('plain string')).toBe('plain string');
    expect(formatRawTransactionError(42)).toBe('42');
  });
});

describe('resolveTransactionErrorMessage', () => {
  it('always rewrites a proving-stage failure to the prover message', () => {
    expect(resolveTransactionErrorMessage(new Error('anything'), 'proving')).toBe(REMOTE_PROVER_FAILED_ERROR);
  });

  it('rewrites a sending-stage timeout only', () => {
    expect(resolveTransactionErrorMessage(new Error('Request Timeout'), 'sending')).toBe(REMOTE_PROVER_FAILED_ERROR);
    expect(resolveTransactionErrorMessage(new Error('insufficient balance'), 'sending')).toBe(
      'Error: insufficient balance'
    );
  });

  it('passes the raw error through for other stages and when no stage is known', () => {
    expect(resolveTransactionErrorMessage(new Error('timeout'), 'confirming')).toBe('Error: timeout');
    expect(resolveTransactionErrorMessage(new Error('timeout'))).toBe('Error: timeout');
    expect(resolveTransactionErrorMessage('raw reason')).toBe('raw reason');
  });
});
