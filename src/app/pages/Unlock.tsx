import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { openInFullPage, useAppEnv } from 'app/env';
import SimplePageLayout from 'app/layouts/SimplePageLayout';
import LogoVerticalTitle from 'app/misc/logo-vertical-title.svg';
import { Button, ButtonVariant } from 'components/Button';
import { useFormAnalytics } from 'lib/analytics';
import { useLocalStorage, useMidenContext } from 'lib/miden/front';
import { MidenSharedStorageKey } from 'lib/miden/types';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

type FormData = {
  password: string;
};

const SUBMIT_ERROR_TYPE = 'submit-error';
const LOCK_TIME = 60_000;
const LAST_ATTEMPT = 3;

const checkTime = (i: number) => (i < 10 ? '0' + i : i);

const getTimeLeft = (start: number, end: number) => {
  const isPositiveTime = start + end - Date.now() < 0 ? 0 : start + end - Date.now();
  const diff = isPositiveTime / 1000;
  const seconds = Math.floor(diff % 60);
  const minutes = Math.floor(diff / 60);
  return `${checkTime(minutes)}:${checkTime(seconds)}`;
};

interface UnlockProps {
  openForgotPasswordInFullPage?: boolean;
}

const Unlock: FC<UnlockProps> = ({ openForgotPasswordInFullPage = false }) => {
  const { t } = useTranslation();
  const { unlock } = useMidenContext();
  const formAnalytics = useFormAnalytics('UnlockWallet');
  const { popup } = useAppEnv();

  const [attempt, setAttempt] = useLocalStorage<number>(MidenSharedStorageKey.PasswordAttempts, 1);
  const [timelock, setTimeLock] = useLocalStorage<number>(MidenSharedStorageKey.TimeLock, 0);
  const lockLevel = LOCK_TIME * Math.floor(attempt / 3);

  // HARDWARE UNLOCK STATE
  // Mobile & Desktop: tries hardware unlock (biometric/passcode) automatically
  // Extension: always shows password form
  const [hardwareUnlockAttempted, setHardwareUnlockAttempted] = useState(false);
  const [hardwareUnlockChecked, setHardwareUnlockChecked] = useState(false);
  // For hardware-only wallets (no password protector), show biometric-only UI
  const [isHardwareOnlyWallet, setIsHardwareOnlyWallet] = useState(false);

  // Use ref to prevent double unlock attempts (React 18 Strict Mode runs effects twice)
  const unlockInProgressRef = useRef(false);

  // On mobile/desktop, try hardware unlock automatically on mount
  useEffect(() => {
    const tryHardwareUnlock = async () => {
      // Only try on mobile or desktop, not extension
      if (isExtension() || hardwareUnlockAttempted) {
        setHardwareUnlockChecked(true);
        return;
      }

      // Guard against double invocation (React Strict Mode, unstable deps, etc.)
      if (unlockInProgressRef.current) {
        console.log('[Unlock] Hardware unlock already in progress, skipping');
        return;
      }
      unlockInProgressRef.current = true;

      setHardwareUnlockAttempted(true);

      try {
        if (isDesktop()) {
          const { hasHardwareKey } = await import('lib/desktop/secure-storage');
          const hasKey = await hasHardwareKey();
          console.log('[Unlock] Desktop hardware key available:', hasKey);

          if (hasKey) {
            console.log('[Unlock] Attempting desktop hardware unlock (Touch ID)...');
            await unlock(); // No password = try hardware unlock
            setAttempt(1);
            navigate('/');
            return;
          }
        } else if (isMobile()) {
          const { hasHardwareKey } = await import('lib/biometric');
          const hasKey = await hasHardwareKey();
          console.log('[Unlock] Mobile hardware key available:', hasKey);

          if (hasKey) {
            console.log('[Unlock] Attempting mobile hardware unlock (biometric)...');
            await unlock(); // No password = try hardware unlock
            setAttempt(1);
            navigate('/');
            return;
          }
        }
      } catch (err) {
        console.log('[Unlock] Hardware unlock failed or cancelled:', err);
        // Check if this is a hardware-only wallet (no password protector)
        // If so, show biometric-only UI instead of password form
        try {
          const { Vault } = await import('lib/miden/back/vault');
          const hasPassword = await Vault.hasPasswordProtector();
          if (!hasPassword) {
            console.log('[Unlock] Hardware-only wallet detected, showing biometric UI');
            setIsHardwareOnlyWallet(true);
          }
        } catch (checkErr) {
          console.log('[Unlock] Failed to check password protector:', checkErr);
        }
      }

      setHardwareUnlockChecked(true);
    };

    tryHardwareUnlock();
  }, [hardwareUnlockAttempted, unlock, setAttempt]);

  const [timeleft, setTimeleft] = useState(getTimeLeft(timelock, lockLevel));

  const formRef = useRef<HTMLFormElement>(null);

  const focusPasswordField = useCallback(() => {
    formRef.current?.querySelector<HTMLInputElement>("input[name='password']")?.focus();
  }, []);

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isSubmitting }
  } = useForm<FormData>();
  const onSubmit = useCallback<SubmitHandler<FormData>>(
    async ({ password }) => {
      if (isSubmitting) return;

      clearErrors('password');
      formAnalytics.trackSubmit();
      try {
        if (attempt > LAST_ATTEMPT) await new Promise(res => setTimeout(res, Math.random() * 2000 + 1000));
        await unlock(password);

        formAnalytics.trackSubmitSuccess();
        setAttempt(1);

        // On mobile/desktop, don't reload - the backend state is already updated in-process.
        // Just navigate to home to trigger a re-render with the unlocked state.
        // On extension, reload to sync with background worker.
        if (!isExtension()) {
          navigate('/');
        } else {
          window.location.reload();
        }
      } catch (err: any) {
        formAnalytics.trackSubmitFail();
        if (attempt >= LAST_ATTEMPT) setTimeLock(Date.now());
        setAttempt(attempt + 1);
        setTimeleft(getTimeLeft(Date.now(), LOCK_TIME * Math.floor((attempt + 1) / 3)));

        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError('password', { type: SUBMIT_ERROR_TYPE, message: err.message });
        focusPasswordField();
      }
    },
    [isSubmitting, clearErrors, setError, unlock, focusPasswordField, formAnalytics, attempt, setAttempt, setTimeLock]
  );

  const onForgotPasswordClick = useCallback(() => {
    if (openForgotPasswordInFullPage) {
      navigate('/forgot-password-info');
      openInFullPage();
      if (popup) {
        window.close();
      }
    } else {
      navigate('/forgot-password-info');
    }
  }, [openForgotPasswordInFullPage, popup]);

  // Retry hardware unlock for hardware-only wallets
  const onRetryHardwareUnlock = useCallback(async () => {
    try {
      await unlock(); // No password = try hardware unlock
      setAttempt(1);
      navigate('/');
    } catch (err) {
      console.log('[Unlock] Hardware unlock retry failed:', err);
      // Stay on the biometric-only UI
    }
  }, [unlock, setAttempt]);

  const isDisabled = useMemo(() => Date.now() - timelock <= lockLevel, [timelock, lockLevel]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (Date.now() - timelock > lockLevel) {
        setTimeLock(0);
      }
      setTimeleft(getTimeLeft(timelock, lockLevel));
    }, 1_000);

    return () => {
      clearInterval(interval);
    };
  }, [timelock, lockLevel, setTimeLock]);

  // Wait for hardware unlock check to complete before showing password form
  // This prevents flash of password form while hardware unlock is being attempted
  if (!hardwareUnlockChecked && !isExtension()) {
    return (
      <SimplePageLayout
        icon={
          <>
            <img alt="Miden Wallet Logo" src={`${LogoVerticalTitle}`} />
          </>
        }
      >
        <div className="flex items-center justify-center h-32">{/* Loading state */}</div>
      </SimplePageLayout>
    );
  }

  // Show biometric-only UI for hardware-only wallets (no password fallback)
  if (isHardwareOnlyWallet) {
    return (
      <SimplePageLayout
        icon={
          <>
            <img alt="Miden Wallet Logo" src={`${LogoVerticalTitle}`} />
          </>
        }
      >
        <div className="w-full max-w-sm mx-auto my-8" style={{ padding: '0px 32px' }}>
          <div className="text-center mb-6">
            <h2 className="text-xl font-semibold mb-2">{t('biometricUnlockRequired')}</h2>
            <p className="text-gray-600 text-sm">{t('biometricUnlockRequiredDescription')}</p>
          </div>
          <Button
            id="retry-biometric"
            title={t('tryAgain')}
            variant={ButtonVariant.Primary}
            onClick={onRetryHardwareUnlock}
            className="w-full justify-center mb-3"
            style={{ fontSize: '16px', lineHeight: '24px', padding: '12px 0px' }}
          />
          <Button
            id="reset-wallet"
            title={t('resetWallet')}
            variant={ButtonVariant.Ghost}
            onClick={onForgotPasswordClick}
            className="w-full justify-center"
            style={{ fontSize: '16px', lineHeight: '24px', padding: '12px 0px' }}
          />
        </div>
      </SimplePageLayout>
    );
  }

  // Show password unlock form (default for extension, fallback for mobile/desktop)
  return (
    <SimplePageLayout
      icon={
        <>
          <img alt="Miden Wallet Logo" src={`${LogoVerticalTitle}`} />
        </>
      }
    >
      {isDisabled && (
        <Alert
          type="error"
          title={t('error')}
          description={`${t('unlockPasswordErrorDelay')} ${timeleft}`}
          className="-mt-16 rounded-lg text-black mx-auto"
          style={{ width: '80%' }}
        />
      )}
      <form
        ref={formRef}
        className="w-full max-w-sm mx-auto my-8"
        onSubmit={handleSubmit(onSubmit)}
        style={{ padding: '0px 32px' }}
      >
        <FormField
          {...register('password', { required: t('required') })}
          label={
            <div className="font-medium -mb-2" style={{ fontSize: '14px', lineHeight: '20px' }}>
              {t('password')}
            </div>
          }
          id="unlock-password"
          type="password"
          name="password"
          placeholder="********"
          errorCaption={errors.password && errors.password.message}
          autoFocus
          containerClassName="mb-3"
          disabled={isDisabled}
        />

        <FormSubmitButton
          disabled={isDisabled}
          loading={isSubmitting}
          className="w-full justify-center rounded-[10px]"
          style={{ fontSize: '16px', lineHeight: '24px', padding: '12px 0px' }}
        >
          {t('unlock')}
        </FormSubmitButton>
        <Button
          id={'forgot-password'}
          title={t('forgotPassword')}
          variant={ButtonVariant.Ghost}
          onClick={onForgotPasswordClick}
          className="w-full justify-center mt-2"
          style={{ fontSize: '16px', lineHeight: '24px', padding: '12px 0px' }}
        />
      </form>
    </SimplePageLayout>
  );
};

export default Unlock;
