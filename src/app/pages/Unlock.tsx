import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { openInFullPage, useAppEnv } from 'app/env';
import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Icon, IconName } from 'app/icons/v2';
import SimplePageLayout from 'app/layouts/SimplePageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { Input } from 'components/Input';
import { PasscodeScreen } from 'components/PasscodeScreen';
import { useFormAnalytics } from 'lib/analytics';
import type { BiometricAvailability } from 'lib/biometric';
import { useLocalStorage, useMidenContext } from 'lib/miden/front';
import { MidenSharedStorageKey } from 'lib/miden/types';
import { hapticLight } from 'lib/mobile/haptics';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

const BrandIcon = () => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2">
      <BreadLogo style={{ width: 80, height: 'auto' }} />
      <span className="text-3xl font-semibold font-heading text-ink">{t('unlockBrandName')}</span>
    </div>
  );
};

const PASSCODE_LENGTH = 6;
const LOCK_TIME = 60_000;
const LAST_ATTEMPT = 3;

const checkTime = (i: number) => (i < 10 ? '0' + i : i);

const formatDuration = (ms: number) => {
  const diff = Math.max(ms, 0) / 1000;
  return `${checkTime(Math.floor(diff / 60))}:${checkTime(Math.floor(diff % 60))}`;
};

const getTimeLeft = (start: number, end: number) => formatDuration(start + end - Date.now());

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
  // Fallback UI: passcode numpad on mobile, password form on extension/desktop
  const [hardwareUnlockAttempted, setHardwareUnlockAttempted] = useState(false);
  const [hardwareUnlockChecked, setHardwareUnlockChecked] = useState(false);
  // For hardware-only wallets (no password protector), show biometric-only UI
  const [isHardwareOnlyWallet, setIsHardwareOnlyWallet] = useState(false);
  // Mobile: a biometric-bound hardware key exists, so the keypad offers a Face ID / Touch ID key
  // that retries the same hardware unlock the mount effect tried first.
  const [hasBiometricKey, setHasBiometricKey] = useState(false);
  // Which sensor the key stands for, so it draws Face ID or a fingerprint rather than Face ID on
  // every device.
  const [biometryType, setBiometryType] = useState<BiometricAvailability['biometryType']>('none');

  // Use ref to prevent double unlock attempts (React 18 Strict Mode runs effects twice)
  const unlockInProgressRef = useRef(false);

  // One unlock() at a time across every path on this screen: the mount-time hardware attempt, the
  // keypad's biometric key and the passcode. Taken at the ENTRY of a path, never at the call:
  // submitPasscode can sleep 1-3s for the post-lockout throttle before reaching unlock(), and a
  // guard taken there leaves that window open to a biometric tap. Distinct from the ref above,
  // which is a one-shot latch against Strict Mode double-running the mount effect and is never
  // released - reusing it here would make every later attempt a no-op.
  const unlockInFlightRef = useRef(false);
  // The ref is the synchronous check-and-set; this is what the screen reads. Every path sets it
  // with the guard and clears it on every exit that does not navigate away, so the keypad, the
  // auto-submit and the password form all wait for the attempt in flight instead of starting one
  // the guard would silently refuse.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const beginUnlock = useCallback(() => {
    if (unlockInFlightRef.current) return false;
    unlockInFlightRef.current = true;
    return true;
  }, []);
  const endUnlock = useCallback(() => {
    unlockInFlightRef.current = false;
  }, []);
  const [biometricError, setBiometricError] = useState(false);

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
      beginUnlock();
      setIsSubmitting(true);
      let navigated = false;

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
            navigated = true;
            return;
          }
        } else if (isMobile()) {
          const { hasHardwareKey, checkBiometricAvailability } = await import('lib/biometric');
          const hasKey = await hasHardwareKey();
          console.log('[Unlock] Mobile hardware key available:', hasKey);
          setHasBiometricKey(hasKey);
          if (hasKey) {
            // Only the glyph depends on this, so a failure to read the sensor must not stop the
            // unlock below: it keeps the default, and the key still works.
            try {
              setBiometryType((await checkBiometricAvailability()).biometryType);
            } catch (sensorErr) {
              console.log('[Unlock] Could not read the biometric sensor type:', sensorErr);
            }
          }

          if (hasKey) {
            console.log('[Unlock] Attempting mobile hardware unlock (biometric)...');
            await unlock();
            setAttempt(1);
            navigate('/');
            navigated = true;
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
      } finally {
        endUnlock();
        if (!navigated) setIsSubmitting(false);
      }

      setHardwareUnlockChecked(true);
    };

    tryHardwareUnlock();
  }, [hardwareUnlockAttempted, unlock, setAttempt, beginUnlock, endUnlock]);

  const [timeleft, setTimeleft] = useState(getTimeLeft(timelock, lockLevel));

  const [code, setCode] = useState('');
  // Extension-only: the vault is protected by a full password, not a passcode.
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isError, setIsError] = useState(false);
  // Counts failed attempts (a rejected passcode, a failed biometric retry); each new value shakes
  // the dots once.
  const [errorCount, setErrorCount] = useState(0);

  const isDisabled = useMemo(() => Date.now() - timelock <= lockLevel, [timelock, lockLevel]);
  // The time left, captured whenever the announcement is re-derived: when the lockout starts, when
  // this screen mounts, and when a failed biometric attempt during the lockout clears again. Never
  // on a clock tick (see `announcement`). `biometricError` is read here, not just listed: the
  // announcement shows the failure instead of a duration while it is set, and a dependency the body
  // ignores is an unnecessary-dependency warning under `yarn lint`. `t` stays out, so its identity
  // cannot re-read the clock.
  const lockoutLeftMs = useMemo(
    () => (isDisabled && !biometricError ? timelock + lockLevel - Date.now() : 0),
    [isDisabled, biometricError, timelock, lockLevel]
  );

  // A failure from before or during a lockout is not what the screen means once the lockout ends:
  // the line would read "incorrect passcode" (or, on the password form, "incorrect password") at the
  // moment the wallet becomes usable again, and the live region would announce it. Cleared on the
  // transition, not on the interval's tick: that branch is also true every second when nothing is
  // locked, and `timelock` outlives its lockout (no success path resets it). No errorCount bump, so
  // nothing shakes. The mount run is a no-op: both flags start false.
  useEffect(() => {
    if (!isDisabled) {
      setIsError(false);
      setBiometricError(false);
    }
  }, [isDisabled]);

  const submitPasscode = useCallback(
    async (passcode: string) => {
      if (isSubmitting || !beginUnlock()) return;
      setIsSubmitting(true);
      setIsError(false);
      setBiometricError(false);

      // Everything that can throw after the take sits in this try, so the finally always releases it.
      try {
        formAnalytics.trackSubmit();
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
        setErrorCount(count => count + 1);
        setCode('');
        setIsSubmitting(false);
      } finally {
        endUnlock();
      }
    },
    [isSubmitting, unlock, formAnalytics, attempt, setAttempt, setTimeLock, beginUnlock, endUnlock]
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
      if (biometricError) setBiometricError(false);
      setCode(prev => (prev.length >= PASSCODE_LENGTH ? prev : prev + digit));
    },
    [isDisabled, isSubmitting, isError, biometricError]
  );

  const handleDelete = useCallback(() => {
    if (isDisabled || isSubmitting) return;
    if (isError) setIsError(false);
    if (biometricError) setBiometricError(false);
    setCode(prev => prev.slice(0, -1));
  }, [isDisabled, isSubmitting, isError, biometricError]);

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

  const onPasswordSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!password || isDisabled || isSubmitting) return;
      submitPasscode(password);
    },
    [password, isDisabled, isSubmitting, submitPasscode]
  );

  const onPasswordChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (isError) setIsError(false);
      setPassword(e.target.value);
    },
    [isError]
  );

  const onRetryHardwareUnlock = useCallback(async () => {
    if (!beginUnlock()) return;
    setIsSubmitting(true);
    // The latest failure is what the screen shows, whichever path it came from.
    setIsError(false);
    setBiometricError(false);
    let navigated = false;
    try {
      await unlock();
      setAttempt(1);
      navigate('/');
      navigated = true;
    } catch (err) {
      console.log('[Unlock] Hardware unlock retry failed:', err);
      // A cancelled prompt lands here too. Say so on screen: the key is tappable on every unlock
      // now, and a retry that fails silently reads as a key that does nothing. Like a rejected
      // passcode it clears the code and shakes the dots once.
      setBiometricError(true);
      setErrorCount(count => count + 1);
      setCode('');
    } finally {
      endUnlock();
      if (!navigated) setIsSubmitting(false);
    }
  }, [unlock, setAttempt, beginUnlock, endUnlock]);

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
            {biometricError && (
              <p role="alert" className="mt-2 text-sm text-negative-ink">
                {t('biometricFailed')}
              </p>
            )}
          </div>
          <Button
            id="retry-biometric"
            title={t('tryAgain')}
            variant={ButtonVariant.Primary}
            onClick={onRetryHardwareUnlock}
            isLoading={isSubmitting}
            disabled={isSubmitting}
            className="w-full mb-3"
          />
          <Button
            id="reset-wallet"
            title={t('resetWallet')}
            variant={ButtonVariant.Ghost}
            onClick={onForgotPasswordClick}
            className="w-full"
          />
        </div>
      </SimplePageLayout>
    );
  }

  // Extension/desktop wallets are protected by a full password (set during
  // onboarding — passcodes are mobile-only), so unlock is a password form:
  // the 6-digit numpad can't type one.
  if (!isMobile()) {
    const passwordSubtitle = isDisabled
      ? `${t('unlockPasswordErrorDelay')} ${timeleft}`
      : isError
        ? t('incorrectPassword')
        : null;

    return (
      <div className="bg-app-bg h-full overflow-y-auto" data-testid="unlock-password">
        <div className="min-h-full flex flex-col items-center px-6 pb-8">
          <div className="flex flex-col items-center w-full mt-10 shrink-0">
            <BrandIcon />
            <h1 className="text-3xl font-semibold font-heading text-ink text-center leading-[100%] tracking-tight mt-8">
              {t('enterYourPassword')}
            </h1>
            <p
              data-testid="unlock-error"
              className={`h-6 text-base text-center mt-3 ${passwordSubtitle ? 'text-red-500' : ''}`}
            >
              {passwordSubtitle}
            </p>
          </div>

          <form className="w-full flex flex-col gap-6 mt-4" onSubmit={onPasswordSubmit}>
            <Input
              id="unlock-password"
              enterKeyHint="go"
              type={isPasswordVisible ? 'text' : 'password'}
              label={t('password')}
              value={password}
              placeholder={t('enterPassword')}
              autoFocus
              disabled={isDisabled}
              icon={
                <button type="button" className="flex-1" onClick={() => setIsPasswordVisible(prev => !prev)}>
                  <Icon name={isPasswordVisible ? IconName.EyeOff : IconName.Eye} fill="currentColor" />
                </button>
              }
              onChange={onPasswordChange}
            />
            <Button
              type="submit"
              title={t('unlock')}
              isLoading={isSubmitting}
              disabled={!password || isDisabled || isSubmitting}
            />
          </form>

          <button
            id="forgot-password"
            type="button"
            onClick={onForgotPasswordClick}
            className="mt-6 text-ink text-base font-medium"
          >
            {t('forgotPassword')}
          </button>
        </div>
      </div>
    );
  }

  // What a screen reader hears. It changes only when the STATE does, never on a clock tick: the
  // visible countdown below re-renders every second, and inside a live region that re-announced
  // the remaining time sixty times a minute. So it carries the time left as captured when the
  // lockout started or the screen mounted - the sentence ends where the duration goes, so dropping
  // it would announce "...blocked for" - or, after a failed biometric attempt during the lockout,
  // that failure: the live region shows `announcement ?? message`, so it must branch here.
  const announcement = !isDisabled
    ? undefined
    : biometricError
      ? t('biometricFailed')
      : `${t('unlockPasswordErrorDelay')} ${formatDuration(lockoutLeftMs)}`;
  const subtitle = isDisabled
    ? `${t('unlockPasswordErrorDelay')} ${timeleft}`
    : isError
      ? t('incorrectPasscode')
      : biometricError
        ? t('biometricFailed')
        : t('enterYour6DigitCode');

  return (
    <PasscodeScreen
      data-testid="unlock-passcode"
      title={t('enterYourPasscode')}
      message={subtitle}
      announcement={announcement}
      isError={isDisabled || isError || biometricError}
      filled={code.length}
      length={PASSCODE_LENGTH}
      errorKey={errorCount}
      onDigit={handleDigit}
      onDelete={handleDelete}
      onBiometric={hasBiometricKey ? onRetryHardwareUnlock : undefined}
      biometryType={biometryType}
      // A press that will be dropped must not look accepted. Entry is refused through a lockout and
      // while any attempt runs; the biometric key only while one runs - it stays usable in a lockout.
      disabled={isDisabled || isSubmitting}
      biometricDisabled={isSubmitting}
      action={
        // Centred under the keypad, where the iOS lock screen keeps its secondary action: in reach,
        // but past the last key row, so it is not hit while a code is typed.
        <button
          id="forgot-password"
          type="button"
          onClick={() => {
            hapticLight();
            onForgotPasswordClick();
          }}
          className="min-h-11 px-3 font-heading text-[15px] font-bold text-accent-tint-ink outline-none rounded-full focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          {t('forgotPasscode')}
        </button>
      }
    />
  );
};

export default Unlock;
