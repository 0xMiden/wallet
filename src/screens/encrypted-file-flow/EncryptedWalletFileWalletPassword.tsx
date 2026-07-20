import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Checkbox } from 'components/Checkbox';
import { Input } from 'components/Input';
import { PasscodeEntry } from 'components/PasscodeEntry';
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
    Vault.hasHardwareProtector().then(setHasHardwareProtector);
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
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && confirmed) {
        e.preventDefault();
        onSubmit();
      }
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

  if (hasHardwareProtector === null) {
    return null;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 text-heading-gray pb-6">
      <div className="flex flex-col">
        <div className="flex flex-col justify-stretch gap-y-4">
          <p className="text-base font-medium leading-[130%]">
            {t(hasHardwareProtector ? 'encryptedWalletFileDescriptionHardware' : 'encryptedWalletFileDescription')}
          </p>
          {!hasHardwareProtector && !usePasscodeEntry && (
            <div className="flex flex-col gap-y-4">
              <Input
                type={isPasswordVisible ? 'text' : 'password'}
                label={t('password')}
                value={walletPassword}
                disabled={isDisabled}
                placeholder={t('enterPassword')}
                icon={
                  <button type="button" className="flex-1" onClick={onPasswordVisibilityToggle}>
                    <Icon name={isPasswordVisible ? IconName.EyeOff : IconName.Eye} fill="currentColor" />
                  </button>
                }
                onChange={e => onPasswordChange(e.target.value)}
                onKeyDown={handleEnterKey}
                autoFocus={!isMobile()}
                labelClassName="text-base! font-medium leading-[20px]"
              />
              {errors.password && <p className="h-4 text-red-500 text-xs">{errors.password.message}</p>}
            </div>
          )}
          <div className="flex gap-x-2 text-sm text-left pb-8">
            <button className="flex mt-3 gap-x-2 text-left" onClick={() => setConfirmed(!confirmed)}>
              <Checkbox id="help-us" value={confirmed} />
              <span className="text-sm leading-[130%] cursor-pointer text-left -mt-1">
                {t('encryptedWalletFileConfirmation')}
              </span>
            </button>
          </div>
          {!hasHardwareProtector && isDisabled && (
            <Alert
              type="error"
              title={t('error')}
              description={`${t('unlockPasswordErrorDelay')} ${timeleft}`}
              className="mt-8 rounded-lg text-black mx-auto"
              style={{ width: '80%' }}
            />
          )}
          {hasHardwareProtector && errors.password && (
            <Alert
              type="error"
              title={t('error')}
              description={errors.password.message || ''}
              className="mt-4 rounded-lg text-black mx-auto"
              style={{ width: '80%' }}
            />
          )}
        </div>
      </div>
      {usePasscodeEntry ? (
        <PasscodeEntry
          onSubmit={code => onSubmit(code)}
          onChange={value => {
            onPasswordChange(value);
            clearErrors('password');
          }}
          error={errors.password?.message ?? null}
          disabled={isDisabled || !confirmed}
          isSubmitting={isSubmitting}
          className="mt-auto"
        />
      ) : (
        <div className="mt-auto">
          <Button
            className="w-full justify-center"
            variant={ButtonVariant.Primary}
            title={t(hasHardwareProtector ? 'unlock' : 'continue')}
            disabled={!continueEnabled}
            onClick={() => onSubmit()}
            isLoading={isSubmitting}
          />
        </div>
      )}
    </div>
  );
};

export default EncryptedWalletFileWalletPassword;
