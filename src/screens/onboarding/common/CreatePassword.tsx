import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { MIN_PASSWORD_LENGTH, PRIVACY_POLICY_URL, STRONG_PASSWORD_LENGTH, TERMS_OF_USE_URL } from 'app/constants';
import { IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { IconButton } from 'components/ui/IconButton';
import { TextField, TextFieldElement } from 'components/ui/TextField';

import { OnboardingStepLayout } from './OnboardingStepLayout';

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

export interface CreatePasswordScreenProps {
  onSubmit?: (password: string) => void;
  'data-testid'?: string;
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
  // The bars take a status fill (never text): red, amber, then green as the password strengthens.
  const validationColor = useMemo(() => {
    if (validationChecks === 5) {
      return 'bg-status-positive';
    }
    if (validationChecks >= 3) {
      return 'bg-status-pending';
    }

    if (validationChecks === 2) {
      return 'bg-status-negative';
    }

    return 'bg-fill-pressed';
  }, [validationChecks]);

  return (
    <div className="min-h-[17px] px-1 font-sans text-[13px] leading-[17px] text-muted">
      {password.length > 0 ? (
        <div className="flex flex-row items-center justify-between gap-3">
          <div className="flex flex-row gap-x-1.5" aria-hidden="true">
            {[2, 3, 5].map(check => (
              <div
                key={`check-${check}`}
                className={`h-1 w-10 rounded-full ${validationChecks >= check ? validationColor : 'bg-fill-pressed'}`}
              />
            ))}
          </div>
          <p>{validationMessage}</p>
        </div>
      ) : (
        <p>{t('minimumCharsWithAtLeast')}</p>
      )}
    </div>
  );
};

export const CreatePasswordScreen: React.FC<CreatePasswordScreenProps> = ({ onSubmit, 'data-testid': dataTestId }) => {
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
  const verifyPasswordRef = useRef<TextFieldElement>(null);

  const onPasswordChange = (e: React.ChangeEvent<TextFieldElement>) => {
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

  const handleTabKey = useCallback((e: React.KeyboardEvent<TextFieldElement>) => {
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
    (e: React.KeyboardEvent<TextFieldElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isValidPassword && onSubmit) {
          onPasswordSubmit();
        }
      }
    },
    [isValidPassword, onPasswordSubmit, onSubmit]
  );

  const passwordsMatch = isValidPassword && password === verifyPassword;
  const passwordsDiffer = verifyPassword.length >= password.length && password !== verifyPassword;

  return (
    <OnboardingStepLayout
      data-testid={dataTestId}
      title={t('createPassword')}
      description={t('createPasswordDescription')}
      footer={
        <>
          {/* Links in running copy take the text-action ink, never the brand orange or an underline. */}
          <p className="px-1 text-center font-sans text-[13px] leading-[17px] text-muted">
            {t('byProceeding')}{' '}
            <a target="_blank" href={TERMS_OF_USE_URL} className="font-bold text-accent-tint-ink" rel="noreferrer">
              {t('termsOfUsage')}
            </a>{' '}
            {t('andWord')}{' '}
            <a target="_blank" href={PRIVACY_POLICY_URL} className="font-bold text-accent-tint-ink" rel="noreferrer">
              {t('privacyPolicy')}
            </a>
            .
          </p>
          <Button
            className="max-w-none"
            data-testid="create-password-submit"
            title={t('continue')}
            disabled={!isValidPassword}
            onClick={onPasswordSubmit}
          />
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <TextField
          data-testid="create-password-input"
          type={isPasswordVisible ? 'text' : 'password'}
          label={t('password')}
          value={password}
          placeholder={t('enterPassword')}
          trailing={
            <IconButton
              icon={isPasswordVisible ? IconName.EyeOff : IconName.Eye}
              label={t(isPasswordVisible ? 'hide' : 'show')}
              onClick={onPasswordVisibilityToggle}
            />
          }
          onChange={onPasswordChange}
          onKeyDown={handleTabKey}
        />
        <PasswordStrengthIndicator password={password} validation={passwordValidation} />
      </div>

      <div className="flex flex-col gap-2">
        <TextField
          data-testid="create-password-verify-input"
          ref={verifyPasswordRef}
          type={isVerifyPasswordVisible ? 'text' : 'password'}
          label={t('verifyPassword')}
          value={verifyPassword}
          placeholder={t('enterPasswordAgain')}
          trailing={
            <IconButton
              icon={isVerifyPasswordVisible ? IconName.EyeOff : IconName.Eye}
              label={t(isVerifyPasswordVisible ? 'hide' : 'show')}
              onClick={onVerifyPasswordVisibilityToggle}
            />
          }
          onChange={e => setVerifyPassword(e.target.value)}
          onKeyDown={handleEnterKey}
        />
        <p
          className={classNames(
            'min-h-[17px] px-1 font-sans text-[13px] leading-[17px] text-positive-ink',
            passwordsMatch ? 'block' : 'hidden'
          )}
        >
          {t('itsAMatch')}
        </p>
        <p
          className={classNames(
            'min-h-[17px] px-1 font-sans text-[13px] leading-[17px] text-negative-ink',
            passwordsDiffer ? 'block' : 'hidden'
          )}
        >
          {t('passwordsDoNotMatch')}
        </p>
      </div>
    </OnboardingStepLayout>
  );
};
