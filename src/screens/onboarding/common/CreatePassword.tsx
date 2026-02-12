import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { MIN_PASSWORD_LENGTH, STRONG_PASSWORD_LENGTH } from 'app/constants';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Input } from 'components/Input';
import { Link } from 'components/Link';

export interface PasswordValidation {
  minChar: boolean;
  cases: boolean;
  number: boolean;
  specialChar: boolean;
  strongPasswordLength?: boolean;
}

const uppercaseLowercaseMixtureRegx = /(?=.*[a-z])(?=.*[A-Z])/;
const lettersNumbersMixtureRegx = /(?=.*\d)(?=.*[A-Za-z])/;
const specialCharacterRegx = /[!@#$%^&*()_+\-=\]{};':"\\|,.<>?]/;

export interface CreatePasswordScreenProps extends Omit<React.ButtonHTMLAttributes<HTMLDivElement>, 'onSubmit'> {
  onSubmit?: (password: string) => void;
}

export const PasswordStrengthIndicator = ({
  password,
  validation
}: {
  password: string;
  validation: PasswordValidation;
}) => {
  const { t } = useTranslation();
  const validationChecks = useMemo(() => Object.values(validation).filter(Boolean).length, [validation]);
  const validationMessage = useMemo(() => {
    if (validationChecks === 5) {
      return t('veryStrong');
    }
    if (validationChecks >= 3) {
      return t('medium');
    }

    if (validationChecks === 2) {
      return t('low');
    }

    return t('8chars1number');
  }, [validationChecks, t]);
  const validationColor = useMemo(() => {
    if (validationChecks === 5) {
      return 'bg-green-500';
    }
    if (validationChecks >= 3) {
      return 'bg-yellow-500';
    }

    if (validationChecks === 2) {
      return 'bg-red-500';
    }

    return 'bg-grey-100';
  }, [validationChecks]);

  // TODO: show strength indicator if password is more than 0 characters
  return (
    <div className="h-4 text-xs">
      {password.length > 0 ? (
        <div className="flex flex-row justify-between items-center">
          <div className="flex flex-row gap-x-2">
            {[2, 3, 5].map(check => (
              <div
                key={`check-${check}`}
                className={`h-1 w-10 rounded-md ${validationChecks >= check ? validationColor : 'bg-grey-100'}`}
              />
            ))}
          </div>
          <p className="text-xs text-grey-600">{validationMessage}</p>
        </div>
      ) : (
        <p className="text-xs text-grey-600">{t('minimumCharsWithAtLeast')}</p>
      )}
    </div>
  );
};

export const CreatePasswordScreen: React.FC<CreatePasswordScreenProps> = ({ className, onSubmit, ...props }) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [verifyPassword, setVerifyPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isVerifyPasswordVisible, setIsVerifyPasswordVisible] = useState(false);
  const [passwordValidation, setPasswordValidation] = useState<PasswordValidation>({
    minChar: false,
    cases: false,
    number: false,
    specialChar: false,
    strongPasswordLength: false
  });
  const verifyPasswordRef = useRef<HTMLInputElement>(null);

  const onPasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
  };

  useEffect(() => {
    setPasswordValidation({
      minChar: password.length >= MIN_PASSWORD_LENGTH,
      cases: uppercaseLowercaseMixtureRegx.test(password),
      number: lettersNumbersMixtureRegx.test(password),
      specialChar: specialCharacterRegx.test(password),
      strongPasswordLength: password.length >= STRONG_PASSWORD_LENGTH
    });
  }, [password]);

  const isValidPassword = useMemo(
    () => Object.values(passwordValidation).filter(Boolean).length > 1 && password === verifyPassword,
    [passwordValidation, password, verifyPassword]
  );

  const handleTabKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      verifyPasswordRef.current?.focus();
    }
  }, []);

  const onPasswordSubmit = useCallback(() => {
    if (isValidPassword && onSubmit) {
      onSubmit(password);
    }
  }, [isValidPassword, onSubmit, password]);

  const onPasswordVisibilityToggle = useCallback(() => {
    setIsPasswordVisible(prev => !prev);
  }, []);

  const onVerifyPasswordVisibilityToggle = useCallback(() => {
    setIsVerifyPasswordVisible(prev => !prev);
  }, []);

  const handleEnterKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isValidPassword && onSubmit) {
          onPasswordSubmit();
        }
      }
    },
    [isValidPassword, onPasswordSubmit, onSubmit]
  );

  return (
    <div className={classNames('flex flex-col', 'bg-white gap-y-6 p-6 text-heading-gray', className)} {...props}>
      <div className="flex flex-col items-center text-heading-gray">
        <header className="text-xl font-semibold">{t('createPassword')}</header>
        <p className="text-sm text-center font-normal mt-2">{t('createPasswordDescription')}</p>
      </div>

      <article className="w-full justify-center items-center flex flex-col gap-y-4">
        <div className="flex flex-col gap-y-2 w-full">
          <Input
            type={isPasswordVisible ? 'text' : 'password'}
            label={t('password')}
            value={password}
            placeholder={t('enterPassword')}
            icon={
              <button className="flex-1" onClick={onPasswordVisibilityToggle}>
                <Icon name={isPasswordVisible ? IconName.EyeOff : IconName.Eye} fill="black" />
              </button>
            }
            onChange={onPasswordChange}
            onKeyDown={handleTabKey}
          />
          <PasswordStrengthIndicator password={password} validation={passwordValidation} />
        </div>

        <div className="flex flex-col gap-y-2 w-full">
          <Input
            ref={verifyPasswordRef}
            type={isVerifyPasswordVisible ? 'text' : 'password'}
            label={t('verifyPassword')}
            value={verifyPassword}
            placeholder={t('enterPasswordAgain')}
            icon={
              <button className="flex-1" onClick={onVerifyPasswordVisibilityToggle}>
                <Icon name={isVerifyPasswordVisible ? IconName.EyeOff : IconName.Eye} fill="black" />
              </button>
            }
            onChange={e => setVerifyPassword(e.target.value)}
            onKeyDown={handleEnterKey}
          />
          <p
            className={classNames(
              'h-4 text-green-500 text-xs',
              isValidPassword && password === verifyPassword ? 'block' : 'hidden'
            )}
          >
            {t('itsAMatch')}
          </p>
          <p
            className={classNames(
              'h-4 text-red-500 text-xs',
              verifyPassword.length >= password.length && password !== verifyPassword ? 'block' : 'hidden'
            )}
          >
            {t('passwordsDoNotMatch')}
          </p>
        </div>
      </article>
      <div className="flex flex-col gap-2 self-center">
        <Button title={t('continue')} disabled={!isValidPassword} onClick={onPasswordSubmit} />
        {/* eslint-disable-next-line i18next/no-literal-string */}
        <p className="text-grey-600 text-xs text-center px-4">
          {t('byProceeding')}{' '}
          <Link target="_blank" href="https://www.miden.fi/terms">
            {t('termsOfUsage')}
          </Link>{' '}
          {t('andWord')}{' '}
          <Link target="_blank" href="https://www.miden.fi/privacy">
            {t('privacyPolicy')}
          </Link>
          .
        </p>
      </div>
    </div>
  );
};
