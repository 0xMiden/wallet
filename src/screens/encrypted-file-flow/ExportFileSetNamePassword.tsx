import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { MIN_PASSWORD_LENGTH, STRONG_PASSWORD_LENGTH } from 'app/constants';
import { lettersNumbersMixtureRegx, specialCharacterRegx, uppercaseLowercaseMixtureRegx } from 'app/defaults';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Input } from 'components/Input';
import { PasswordStrengthIndicator, PasswordValidation } from 'screens/onboarding/common/CreatePassword';

export interface ExportFilePasswordProps {
  onGoNext: () => void;
  onGoBack: () => void;
  passwordValue: string;
  handlePasswordChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  fileName: string;
  onFileNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

const ExportFilePassword: React.FC<ExportFilePasswordProps> = ({
  onGoBack,
  onGoNext,
  handlePasswordChange,
  passwordValue,
  fileName,
  onFileNameChange
}) => {
  const { t } = useTranslation();

  const [verifyPassword, setVerifyPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const onPasswordVisibilityToggle = useCallback(() => {
    setIsPasswordVisible(prev => !prev);
  }, []);
  const [isVerifyPasswordVisible, setIsVerifyPasswordVisible] = useState(false);
  const onVerifyPasswordVisibilityToggle = useCallback(() => {
    setIsVerifyPasswordVisible(prev => !prev);
  }, []);

  const passwordRef = useRef<HTMLInputElement>(null);
  const handleNameInputTab = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      passwordRef.current?.focus();
    }
  }, []);

  const verifyPasswordRef = useRef<HTMLInputElement>(null);
  const handlePasswordInputTab = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      verifyPasswordRef.current?.focus();
    }
  }, []);

  const [passwordValidation, setPasswordValidation] = useState<PasswordValidation>({
    minChar: false,
    cases: false,
    number: false,
    specialChar: false,
    strongPasswordLength: passwordValue.length >= STRONG_PASSWORD_LENGTH
  });

  useEffect(() => {
    setPasswordValidation({
      minChar: passwordValue.length >= MIN_PASSWORD_LENGTH,
      cases: uppercaseLowercaseMixtureRegx.test(passwordValue),
      number: lettersNumbersMixtureRegx.test(passwordValue),
      specialChar: specialCharacterRegx.test(passwordValue),
      strongPasswordLength: passwordValue.length >= STRONG_PASSWORD_LENGTH
    });
  }, [passwordValue]);

  const isValidPassword = useMemo(
    () => Object.values(passwordValidation).filter(Boolean).length > 1 && passwordValue === verifyPassword,
    [passwordValidation, passwordValue, verifyPassword]
  );

  const handleEnterKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isValidPassword) {
          onGoNext();
        }
      }
    },
    [isValidPassword, onGoNext]
  );

  const DEFAULT_FILE_NAME = 'Encrypted Wallet File';
  const EXTENSION = '.json';

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto">
      <div className="flex flex-col justify-stretch p-4 pt-8 overflow-y-auto">
        <Input
          placeholder={DEFAULT_FILE_NAME}
          value={fileName}
          label={t('name')}
          onChange={onFileNameChange}
          suffix={EXTENSION}
          onKeyDown={handleNameInputTab}
          tabIndex={0}
          autoFocus
          labelClassName="text-[20px] font-semibold leading-[20px]"
          inputClassName="placeholder:text-gray-800 placeholder:text-sm placeholder:font-bold h-14"
          containerClassName="gap-4"
        />

        <div className="w-full items-center flex flex-col gap-y-4 flex-1 pt-6">
          <p className="text-base text-left font-bold mt-2">{t('enterPasswordToEncrypt')}</p>
          <div className="w-full flex flex-col gap-y-4">
            <Input
              ref={passwordRef}
              type={isPasswordVisible ? 'text' : 'password'}
              label={t('password')}
              value={passwordValue}
              placeholder={t('enterPassword')}
              icon={
                <button className="flex-1" onClick={onPasswordVisibilityToggle}>
                  <Icon name={isPasswordVisible ? IconName.EyeOff : IconName.Eye} fill="black" />
                </button>
              }
              onChange={handlePasswordChange}
              onKeyDown={handlePasswordInputTab}
              tabIndex={1}
              labelClassName="text-[20px] font-semibold leading-[20px]"
              containerClassName="gap-4"
              inputClassName="placeholder:text-gray-800 placeholder:text-sm placeholder:font-bold h-14"
            />
            <PasswordStrengthIndicator password={passwordValue} validation={passwordValidation} />
          </div>
          <div className="w-full flex flex-col gap-y-2">
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
              tabIndex={2}
              labelClassName="text-[20px] font-semibold leading-[20px]"
              containerClassName="gap-4"
              inputClassName="placeholder:text-gray-800 placeholder:text-sm placeholder:font-bold h-14"
            />
            <p
              className={classNames(
                'h-4 text-green-500 text-xs',
                isValidPassword && passwordValue === verifyPassword ? 'block' : 'hidden'
              )}
            >
              {t('itsAMatch')}
            </p>
            <p
              className={classNames(
                'h-4 text-red-500 text-xs',
                verifyPassword.length >= passwordValue.length && passwordValue !== verifyPassword ? 'block' : 'hidden'
              )}
            >
              {t('passwordsDoNotMatch')}
            </p>
          </div>
        </div>

        <Button
          variant={ButtonVariant.Primary}
          onClick={onGoNext}
          title={t('continue')}
          className="mt-8"
          disabled={!passwordValue || !verifyPassword || !fileName}
        />
      </div>
    </div>
  );
};

export default ExportFilePassword;
