import { MIN_PASSWORD_LENGTH, STRONG_PASSWORD_LENGTH } from 'app/constants';
import { lettersNumbersMixtureRegx, specialCharacterRegx, uppercaseLowercaseMixtureRegx } from 'app/defaults';

export interface PasswordValidation {
  minChar: boolean;
  cases: boolean;
  number: boolean;
  specialChar: boolean;
  strongPasswordLength?: boolean;
}

export function validateNewPassword(password: string): PasswordValidation {
  return {
    minChar: password.length >= MIN_PASSWORD_LENGTH,
    cases: uppercaseLowercaseMixtureRegx.test(password),
    number: lettersNumbersMixtureRegx.test(password),
    specialChar: specialCharacterRegx.test(password),
    strongPasswordLength: password.length >= STRONG_PASSWORD_LENGTH
  };
}

// Length is the rule; the other criteria only feed the strength meter. Applies to NEW passwords only:
// existing ones of any length must keep unlocking.
export function isAcceptableNewPassword(validation: PasswordValidation): boolean {
  return validation.minChar;
}
