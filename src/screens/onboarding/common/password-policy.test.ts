import { MIN_PASSWORD_LENGTH } from 'app/constants';

import { isAcceptableNewPassword, validateNewPassword } from './password-policy';

describe('new-password policy', () => {
  it('MIN_PASSWORD_LENGTH is 12', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it('refuses 11 characters that meet every other criterion', () => {
    expect(isAcceptableNewPassword(validateNewPassword('Abcdefgh1!x'))).toBe(false);
  });

  it('accepts 12 characters', () => {
    expect(isAcceptableNewPassword(validateNewPassword('abcdefghijkl'))).toBe(true);
  });

  it('refuses a short password that meets two criteria', () => {
    const validation = validateNewPassword('aB1');
    expect(Object.values(validation).filter(Boolean).length).toBeGreaterThan(1);
    expect(isAcceptableNewPassword(validation)).toBe(false);
  });
});
