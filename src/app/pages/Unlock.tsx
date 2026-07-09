import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { openInFullPage, useAppEnv } from 'app/env';
import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import SimplePageLayout from 'app/layouts/SimplePageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { Numpad } from 'components/Numpad';
import { useFormAnalytics } from 'lib/analytics';
import { useLocalStorage, useMidenContext } from 'lib/miden/front';
import { MidenSharedStorageKey } from 'lib/miden/types';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

const BrandIcon = () => (
  <div className="flex flex-col items-center gap-2">
    <BreadLogo style={{ width: 80, height: 'auto' }} />
    <span className="text-3xl font-semibold font-heading text-heading-gray">Bread</span>
  </div>
);

const PASSCODE_LENGTH = 6;
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
  const { compact } = useAppEnv();

  const [attempt, setAttempt] = useLocalStorage<number>(MidenSharedStorageKey.PasswordAttempts, 1);
  const [timelock, setTimeLock] = useLocalStorage<number>(MidenSharedStorageKey.TimeLock, 0);
  const lockLevel = LOCK_TIME * Math.floor(attempt / 3);

  // HARDWARE UNLOCK STATE
  // Mobile & Desktop: tries hardware unlock (biometric/passcode) automatically
  // Extension: always shows passcode entry
  const [hardwareUnlockAttempted, setHardwareUnlockAttempted] = useState(false);
  const [hardwareUnlockChecked, setHardwareUnlockChecked] = useState(false);
  // For hardware-only wallets (no password protector), show biometric-only UI
  const [isHardwareOnlyWallet, setIsHardwareOnlyWallet] = useState(false);

  // Use ref to prevent double unlock attempts (React 18 Strict Mode runs effects twice)
  const unlockInProgressRef = useRef(false);

  // On mobile/desktop, try hardware unlock automatically on mount
  useEffect(() => {
    const tryHardwareUnlock = async () => {
      if (isExtension() || hardwareUnlockAttempted) {
        setHardwareUnlockChecked(true);
        return;
      }

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
            await unlock();
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
            await unlock();
            setAttempt(1);
            navigate('/');
            return;
          }
        }
      } catch (err) {
        console.log('[Unlock] Hardware unlock failed or cancelled:', err);
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

  const [code, setCode] = useState('');
  const [isError, setIsError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isDisabled = useMemo(() => Date.now() - timelock <= lockLevel, [timelock, lockLevel]);

  const submitPasscode = useCallback(
    async (passcode: string) => {
      if (isSubmitting) return;
      setIsSubmitting(true);
      setIsError(false);
      formAnalytics.trackSubmit();

      try {
        if (attempt > LAST_ATTEMPT) await new Promise(res => setTimeout(res, Math.random() * 2000 + 1000));
        await unlock(passcode);

        formAnalytics.trackSubmitSuccess();
        setAttempt(1);

        // On mobile/desktop, don't reload - the backend state is already updated in-process.
        // On extension, reload to sync with background worker.
        if (!isExtension()) {
          navigate('/');
        } else {
          window.location.reload();
        }
      } catch (err) {
        formAnalytics.trackSubmitFail();
        if (attempt >= LAST_ATTEMPT) setTimeLock(Date.now());
        setAttempt(attempt + 1);
        setTimeleft(getTimeLeft(Date.now(), LOCK_TIME * Math.floor((attempt + 1) / 3)));

        console.error(err);

        await new Promise(res => setTimeout(res, 300));
        setIsError(true);
        setCode('');
        setIsSubmitting(false);
      }
    },
    [isSubmitting, unlock, formAnalytics, attempt, setAttempt, setTimeLock]
  );

  useEffect(() => {
    if (code.length === PASSCODE_LENGTH && !isSubmitting) {
      const timer = setTimeout(() => {
        submitPasscode(code);
      }, 150);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [code, isSubmitting, submitPasscode]);

  const handleDigit = useCallback(
    (digit: string) => {
      if (isDisabled || isSubmitting) return;
      if (isError) setIsError(false);
      setCode(prev => (prev.length >= PASSCODE_LENGTH ? prev : prev + digit));
    },
    [isDisabled, isSubmitting, isError]
  );

  const handleDelete = useCallback(() => {
    if (isDisabled || isSubmitting) return;
    if (isError) setIsError(false);
    setCode(prev => prev.slice(0, -1));
  }, [isDisabled, isSubmitting, isError]);

  const onForgotPasswordClick = useCallback(() => {
    if (openForgotPasswordInFullPage) {
      navigate('/forgot-password-info');
      openInFullPage();
      if (compact) {
        window.close();
      }
    } else {
      navigate('/forgot-password-info');
    }
  }, [openForgotPasswordInFullPage, compact]);

  const onRetryHardwareUnlock = useCallback(async () => {
    try {
      await unlock();
      setAttempt(1);
      navigate('/');
    } catch (err) {
      console.log('[Unlock] Hardware unlock retry failed:', err);
    }
  }, [unlock, setAttempt]);

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

  // Wait for hardware unlock check to complete before showing passcode UI
  if (!hardwareUnlockChecked && !isExtension()) {
    return (
      <SimplePageLayout icon={<BrandIcon />}>
        <div className="flex items-center justify-center h-32" />
      </SimplePageLayout>
    );
  }

  // Hardware-only wallet (no password protector) — biometric retry UI
  if (isHardwareOnlyWallet) {
    return (
      <SimplePageLayout icon={<BrandIcon />}>
        <div className="w-full max-w-sm mx-auto my-8" style={{ padding: '0px 32px' }}>
          <div className="text-center mb-6">
            <h2 className="text-xl font-semibold mb-2">{t('biometricUnlockRequired')}</h2>
            <p className="text-text-muted text-sm">{t('biometricUnlockRequiredDescription')}</p>
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

  const subtitle = isDisabled
    ? `${t('unlockPasswordErrorDelay')} ${timeleft}`
    : isError
      ? t('incorrectPasscode')
      : t('enterYour6DigitCode');

  const subtitleClass = isDisabled || isError ? 'text-red-500' : 'text-gray-secondary';

  return (
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="unlock-passcode">
      <div className="min-h-full flex flex-col items-center px-6 pb-8">
        <div className="flex flex-col items-center w-full mt-8 shrink-0">
          <h1 className="text-3xl font-semibold font-heading text-heading-gray text-center leading-[100%] tracking-tight">
            {t('enterYourPasscode')}
          </h1>
          <p className={`text-lg text-center mt-3 ${subtitleClass}`}>{subtitle}</p>

          <div className="flex items-center gap-3.5 mt-6">
            {Array.from({ length: PASSCODE_LENGTH }).map((_, index) => {
              const filled = index < code.length;
              return (
                <div
                  key={index}
                  className={
                    filled
                      ? 'w-3.5 h-3.5 rounded-full bg-[#C7C7CC] border-2 border-[#C7C7CC]'
                      : 'w-3.5 h-3.5 rounded-full border-2 border-[#C7C7CC]'
                  }
                />
              );
            })}
          </div>
        </div>

        <div className="w-full pt-8">
          <Numpad onDigit={handleDigit} onDelete={handleDelete} />
        </div>

        <button
          id="forgot-password"
          type="button"
          onClick={onForgotPasswordClick}
          className="mt-4 text-heading-gray text-base font-medium"
        >
          {t('forgotPasscode')}
        </button>
      </div>
    </div>
  );
};

export default Unlock;
