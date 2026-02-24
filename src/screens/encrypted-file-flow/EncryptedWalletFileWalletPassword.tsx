import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Checkbox } from 'components/Checkbox';
import { Input } from 'components/Input';
import { Vault } from 'lib/miden/back/vault';
import { useLocalStorage, useMidenContext } from 'lib/miden/front';

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
  onPasswordChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
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
    formState: { errors, isSubmitting }
  } = useForm<FormData>();
  const [confirmed, setConfirmed] = useState(false);
  const [hasHardwareProtector, setHasHardwareProtector] = useState(false);
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

  const onSubmit = useCallback(async () => {
    if (isSubmitting) return;

    clearErrors('password');
    try {
      if (!hasHardwareProtector && attempt > LAST_ATTEMPT)
        await new Promise(res => setTimeout(res, Math.random() * 2000 + 1000));
      await unlock(hasHardwareProtector ? undefined : walletPassword!);

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
    }
  }, [
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
  ]);

  const handleEnterKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && confirmed) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit, confirmed]
  );

  return (
    <div className="flex-1 flex flex-col text-heading-gray">
      <div className="flex flex-col flex-1 p-4 pt-8">
        <div className="flex-1 flex flex-col justify-stretch gap-y-4">
          <p className="text-base font-normal">
            {t(hasHardwareProtector ? 'encryptedWalletFileDescriptionHardware' : 'encryptedWalletFileDescription')}
          </p>
          {!hasHardwareProtector && (
            <div className="flex flex-col gap-y-4">
              <Input
                type={isPasswordVisible ? 'text' : 'password'}
                label={t('password')}
                value={walletPassword}
                disabled={isDisabled}
                placeholder={t('enterPassword')}
                icon={
                  <button className="flex-1" onClick={onPasswordVisibilityToggle}>
                    <Icon name={isPasswordVisible ? IconName.EyeOff : IconName.Eye} fill="black" />
                  </button>
                }
                onChange={onPasswordChange}
                onKeyDown={handleEnterKey}
                autoFocus
                labelClassName="text-[20px] font-medium leading-[20px]"
              />
              {errors.password && <p className="h-4 text-red-500 text-xs">{errors.password.message}</p>}
            </div>
          )}
          <div className="flex gap-x-2 text-sm text-left">
            <button className="flex mt-3 gap-x-2 text-left" onClick={() => setConfirmed(!confirmed)}>
              <Checkbox id="help-us" value={confirmed} />
              <span className="text-sm cursor-pointer text-left -mt-1">{t('encryptedWalletFileConfirmation')}</span>
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
        <Button
          className="w-full justify-center mt-6"
          variant={ButtonVariant.Primary}
          title={t(hasHardwareProtector ? 'unlock' : 'continue')}
          disabled={hasHardwareProtector ? !confirmed : isDisabled || !confirmed || !walletPassword}
          onClick={onSubmit}
          isLoading={isSubmitting}
        />
      </div>
    </div>
  );
};

export default EncryptedWalletFileWalletPassword;
