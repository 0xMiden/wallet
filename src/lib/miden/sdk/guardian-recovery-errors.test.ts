import { GUARDIAN_ACCOUNT_NOT_FOUND, NoGuardianAccountsFoundError } from './guardian-recovery-errors';

describe('NoGuardianAccountsFoundError', () => {
  it('carries the not-found code', () => {
    expect(new NoGuardianAccountsFoundError().code).toBe(GUARDIAN_ACCOUNT_NOT_FOUND);
  });

  it('keeps a caller-supplied message', () => {
    const err = new NoGuardianAccountsFoundError('No Guardian account was found for this key at this Guardian.');
    expect(err.message).toBe('No Guardian account was found for this key at this Guardian.');
    expect(err.code).toBe(GUARDIAN_ACCOUNT_NOT_FOUND);
  });
});
