import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { CheckboxConsent } from 'components/ui/Checkbox';
import { IconButton } from 'components/ui/IconButton';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField, TextFieldElement } from 'components/ui/TextField';
import { Vault } from 'lib/miden/back/vault';
import { useLocalStorage, useMidenContext } from 'lib/miden/front';
import { isMobile } from 'lib/platform';

const SUBMIT_ERROR_TYPE = 'submit-error';
const LOCK_TIME = 60_000;

type FormData = {
  password: string;
};

const LAST_ATTEMPT = 3;

const checkTime = (i: number) => (i < 10 ? '0' + i : i);

const getTimeLeft = (start: number, end: number) => {
  const isPositiveTime = start + end - Date.now() < 0 ? 0 : start + end - Date.now();
  const diff = isPositiveTime / 1000;
  const seconds = Math.floor(diff % 60);
  const minutes = Math.floor(diff / 60);
  return `${checkTime(minutes)}:${checkTime(seconds)}`;
};

export interface EncryptedWalletFileWalletPasswordProps {
  onGoNext: () => void;
  onGoBack: () => void;
  onPasswordChange: (value: string) => void;
  walletPassword?: string;
}

const EncryptedWalletFileWalletPassword: React.FC<EncryptedWalletFileWalletPasswordProps> = ({
  onGoNext,
  onPasswordChange,
  walletPassword
}) => {
  const { unlock } = useMidenContext();
  const { t } = useTranslation();
  const {
    setError,
    clearErrors,
    formState: { errors }
  } = useForm<FormData>();
  // This form submits directly (not via react-hook-form's handleSubmit), so
  // formState.isSubmitting never flips true; track the in-flight state ourselves
  // so the guard, the loading spinner, and PasscodeEntry's auto-submit all work.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useLocalStorage<number>('TridentSharedStorageKey.PasswordAttempts', 1);
  const [timelock, setTimeLock] = useLocalStorage<number>('TridentSharedStorageKey.TimeLock', 0);
  const lockLevel = LOCK_TIME * Math.floor(attempt / 3);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const onPasswordVisibilityToggle = useCallback(() => {
    setIsPasswordVisible(prev => !prev);
  }, []);
  const [timeleft, setTimeleft] = useState(getTimeLeft(timelock, lockLevel));

  const isDisabled = useMemo(() => Date.now() - timelock <= lockLevel, [timelock, lockLevel]);

  useEffect(() => {
    // This step draws the flow's only header and its body waits for the probe, so a rejection
    // falls back to the password step-up rather than leaving an empty page for good.
    Vault.hasHardwareProtector()
      .then(setHasHardwareProtector)
      .catch(() => setHasHardwareProtector(false));
  }, []);

  const onSubmit = useCallback(
    async (passcode?: string) => {
      if (isSubmitting) return;
      setIsSubmitting(true);

      clearErrors('password');
      try {
        if (!hasHardwareProtector && attempt > LAST_ATTEMPT)
          await new Promise(res => setTimeout(res, Math.random() * 2000 + 1000));
        await unlock(hasHardwareProtector ? undefined : (passcode ?? walletPassword)!);

        setAttempt(1);
        onGoNext();
      } catch (err: any) {
        if (!hasHardwareProtector) {
          if (attempt >= LAST_ATTEMPT) setTimeLock(Date.now());
          setAttempt(attempt + 1);
          setTimeleft(getTimeLeft(Date.now(), LOCK_TIME * Math.floor((attempt + 1) / 3)));
        }

        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError('password', { type: SUBMIT_ERROR_TYPE, message: err.message });
        setIsSubmitting(false);
      }
    },
    [
      isSubmitting,
      clearErrors,
      setError,
      unlock,
      attempt,
      setAttempt,
      setTimeLock,
      onGoNext,
      walletPassword,
      hasHardwareProtector
    ]
  );

  const handleEnterKey = useCallback(
    (e: React.KeyboardEvent<TextFieldElement>) => {
      if (e.key !== 'Enter') return;
      // Always swallowed: this step is now a page inside the flow's own form, whose submit
      // handler only clears errors, and Enter must not fire it before the confirmation is ticked.
      e.preventDefault();
      if (confirmed) onSubmit();
    },
    [onSubmit, confirmed]
  );

  const continueEnabled = hasHardwareProtector
    ? !!confirmed && !isSubmitting
    : !isDisabled && !!confirmed && !!walletPassword && !isSubmitting;

  // Non-hardware mobile wallets are protected by the 6-digit onboarding
  // passcode, so unlock with the numpad (auto-submits once six digits are
  // entered); extension/desktop use a typed password.
  const usePasscodeEntry = isMobile() && hasHardwareProtector === false;

  // The frame renders while the protector check runs, so the flow's title and back are there from
  // the first frame; the body waits.
  if (hasHardwareProtector === null) {
    return <SubPageLayout data-testid="encrypted-file-wallet-password">{null}</SubPageLayout>;
  }

  return (
    // A page on the shared frame: the header, the 16px margin and the pinned action all come from
    // the layout, and the flow above hands it the title and the back.
    <SubPageLayout
      data-testid="encrypted-file-wallet-password"
      // The title takes focus only where no field does: the desktop password field autofocuses.
      // This is what focuses the title under a host that does not.
      focusTitleOnMount={isMobile() || hasHardwareProtector}
      footer={
        usePasscodeEntry ? undefined : (
          <Button
            className="flex-1 max-w-none"
            variant={ButtonVariant.Primary}
            data-testid="encrypted-file-wallet-password-submit"
            title={t(hasHardwareProtector ? 'unlock' : 'continue')}
            disabled={!continueEnabled}
            onClick={() => onSubmit()}
            isLoading={isSubmitting}
          />
        )
      }
    >
      <SubPageSection
        description={t(
          hasHardwareProtector ? 'encryptedWalletFileDescriptionHardware' : 'encryptedWalletFileDescription'
        )}
      >
        {!hasHardwareProtector && !usePasscodeEntry && (
          <TextField
            type={isPasswordVisible ? 'text' : 'password'}
            label={t('password')}
            value={walletPassword}
            disabled={isDisabled}
            placeholder={t('enterPassword')}
            trailing={
              <IconButton
                icon={isPasswordVisible ? IconName.EyeOff : IconName.Eye}
                label={t(isPasswordVisible ? 'hide' : 'show')}
                onClick={onPasswordVisibilityToggle}
              />
            }
            onChange={e => onPasswordChange(e.target.value)}
            onKeyDown={handleEnterKey}
            autoFocus={!isMobile()}
            error={errors.password?.message}
            data-testid="encrypted-file-wallet-password-input"
          />
        )}
      </SubPageSection>

      <CheckboxConsent
        checked={confirmed}
        onCheckedChange={setConfirmed}
        data-testid="encrypted-file-wallet-password-consent"
      >
        {t('encryptedWalletFileConfirmation')}
      </CheckboxConsent>

      {!hasHardwareProtector && isDisabled && (
        <Notice tone="negative" role="alert" title={t('error')}>
          {`${t('unlockPasswordErrorDelay')} ${timeleft}`}
        </Notice>
      )}
      {hasHardwareProtector && errors.password && (
        <Notice tone="negative" role="alert" title={t('error')}>
          {errors.password.message || ''}
        </Notice>
      )}

      {usePasscodeEntry && (
        <PasscodeEntry
          onSubmit={code => onSubmit(code)}
          onChange={value => {
            onPasswordChange(value);
            clearErrors('password');
          }}
          error={errors.password?.message ?? null}
          disabled={isDisabled || !confirmed}
          isSubmitting={isSubmitting}
          className="mt-auto pb-2"
        />
      )}
    </SubPageLayout>
  );
};

export default EncryptedWalletFileWalletPassword;
