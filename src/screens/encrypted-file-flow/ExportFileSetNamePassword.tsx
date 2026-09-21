import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { MIN_PASSWORD_LENGTH, STRONG_PASSWORD_LENGTH } from 'app/constants';
import { lettersNumbersMixtureRegx, specialCharacterRegx, uppercaseLowercaseMixtureRegx } from 'app/defaults';
import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { IconButton } from 'components/ui/IconButton';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField, TextFieldElement } from 'components/ui/TextField';
import { PasswordStrengthIndicator, PasswordValidation } from 'screens/onboarding/common/CreatePassword';

export interface ExportFilePasswordProps {
  onGoNext: () => void;
  onGoBack: () => void;
  passwordValue: string;
  handlePasswordChange: (event: React.ChangeEvent<TextFieldElement>) => void;
  fileName: string;
  onFileNameChange: (event: React.ChangeEvent<TextFieldElement>) => void;
}

const ExportFilePassword: React.FC<ExportFilePasswordProps> = ({
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

  const passwordRef = useRef<TextFieldElement>(null);
  const handleNameInputTab = useCallback((e: React.KeyboardEvent<TextFieldElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      passwordRef.current?.focus();
    }
  }, []);

  const verifyPasswordRef = useRef<TextFieldElement>(null);
  const handlePasswordInputTab = useCallback((e: React.KeyboardEvent<TextFieldElement>) => {
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
    (e: React.KeyboardEvent<TextFieldElement>) => {
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

  const visibilityToggle = (visible: boolean, onToggle: () => void) => (
    <IconButton
      icon={visible ? IconName.EyeOff : IconName.Eye}
      label={t(visible ? 'hide' : 'show')}
      onClick={onToggle}
    />
  );

  return (
    <SubPageLayout
      data-testid="export-file-password"
      footer={
        <Button
          variant={ButtonVariant.Primary}
          onClick={onGoNext}
          title={t('continue')}
          className="flex-1 max-w-none"
          data-testid="export-file-submit"
          disabled={!passwordValue || !verifyPassword || !fileName || !isValidPassword}
        />
      }
    >
      <TextField
        data-testid="export-file-name-input"
        placeholder={DEFAULT_FILE_NAME}
        value={fileName}
        label={t('name')}
        onChange={onFileNameChange}
        trailing={<span className="text-body text-muted">{EXTENSION}</span>}
        onKeyDown={handleNameInputTab}
        tabIndex={0}
        autoFocus
      />

      <SubPageSection description={t('enterPasswordToEncrypt')} className="gap-4">
        <TextField
          ref={passwordRef}
          data-testid="export-file-password-input"
          type={isPasswordVisible ? 'text' : 'password'}
          label={t('password')}
          value={passwordValue}
          placeholder={t('enterPassword')}
          trailing={visibilityToggle(isPasswordVisible, onPasswordVisibilityToggle)}
          onChange={handlePasswordChange}
          onKeyDown={handlePasswordInputTab}
          tabIndex={1}
        />
        <PasswordStrengthIndicator password={passwordValue} validation={passwordValidation} />
      </SubPageSection>

      <div className="flex flex-col gap-2">
        <TextField
          ref={verifyPasswordRef}
          data-testid="export-file-password-verify-input"
          type={isVerifyPasswordVisible ? 'text' : 'password'}
          label={t('verifyPassword')}
          value={verifyPassword}
          placeholder={t('enterPasswordAgain')}
          trailing={visibilityToggle(isVerifyPasswordVisible, onVerifyPasswordVisibilityToggle)}
          onChange={e => setVerifyPassword(e.target.value)}
          onKeyDown={handleEnterKey}
          tabIndex={2}
        />
        <p
          className={classNames(
            'h-4 px-1 text-caption text-positive-ink',
            isValidPassword && passwordValue === verifyPassword ? 'block' : 'hidden'
          )}
        >
          {t('itsAMatch')}
        </p>
        <p
          className={classNames(
            'h-4 px-1 text-caption text-negative-ink',
            verifyPassword.length >= passwordValue.length && passwordValue !== verifyPassword ? 'block' : 'hidden'
          )}
        >
          {t('passwordsDoNotMatch')}
        </p>
      </div>
    </SubPageLayout>
  );
};

export default ExportFilePassword;
