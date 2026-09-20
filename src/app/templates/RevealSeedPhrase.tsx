import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { AnimatedCopyIcon, CopyLabel } from 'components/ui/CopyFeedback';
import { Hero } from 'components/ui/Hero';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { TextField } from 'components/ui/TextField';
import { COPY_FEEDBACK_MS } from 'lib/animation/copy';
import { Vault } from 'lib/miden/back/vault';
import { useMidenContext, useSecretState } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';

import { SEED_STATE_NOTICE } from './seed-state-notice';

type FormData = {
  password: string;
};

// The page opens on the privacy warning; the auth gate and the words come only after View.
type Step = 'warning' | 'reveal';

const RevealSeedPhrase: FC = () => {
  const { t } = useTranslation();
  const { revealMnemonic } = useMidenContext();
  const secretGeneration = useRef(0);
  const seedStatus = useWalletStore(s => s.seedPhraseStatus);
  useEffect(
    () => () => {
      secretGeneration.current += 1;
    },
    [seedStatus]
  );
  const { fieldRef, copy, copied } = useCopyToClipboard(COPY_FEEDBACK_MS);
  const [secret, setSecret] = useSecretState();
  const [step, setStep] = useState<Step>('warning');
  // Every exit from this page goes through `leave`, never `goBack()` directly.
  // Several paths want out at once — a failed biometric reveal's catch, then the
  // auto-close effect once `finally` clears isSubmitting; Hide and the drawer's
  // close, which also trip that effect — and `history.go(-1)` settles on a later
  // task, so each call popped another page (Settings too). The hook fires once
  // per location, and routes to the Settings root when opened cold.
  const leave = useBackWithFallback('/settings');
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [showPasswordDrawer, setShowPasswordDrawer] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Block screenshots/recordings while the phrase is revealed (#417). The
  // phrase is only rendered once the guard reports the screen is protected.
  const isGuardReady = useScreenshotGuard(secret !== null);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setError,
    clearErrors
  } = useForm<FormData>();

  const passwordValue = watch('password');

  useEffect(() => {
    if (seedStatus && seedStatus !== 'stored') setSecret(null);
  }, [seedStatus, setSecret]);

  // Detect the auth type on mount, so View knows which gate to open.
  useEffect(() => {
    if (seedStatus && seedStatus !== 'stored') return;
    let cancelled = false;
    Vault.hasHardwareProtector()
      .then(hasHw => {
        if (!cancelled) setHasHardwareProtector(hasHw);
      })
      .catch(() => {
        if (!cancelled) setHasHardwareProtector(false);
      });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // No haptic here: Button fires one on every click.
  const handleView = useCallback(() => {
    if (hasHardwareProtector === null || isSubmitting) return;
    if (!hasHardwareProtector) {
      // Password-backed: the page moves on to the password drawer.
      setStep('reveal');
      setShowPasswordDrawer(true);
      return;
    }
    // Hardware-backed: the biometric prompt runs over the warning, which stays
    // on screen (View spinning) until the words or the error are ready.
    const generation = secretGeneration.current;
    setIsSubmitting(true);
    revealMnemonic(undefined)
      .then(mnemonic => {
        if (generation !== secretGeneration.current) return;
        setSecret(mnemonic);
        setStep('reveal');
      })
      .catch((err: unknown) => {
        // Same generation guard the success branch and the password path
        // (below) already take: a rejection from a superseded request must
        // not navigate away from the view that replaced it.
        if (generation !== secretGeneration.current) return;
        setAuthError(err instanceof Error ? err.message : String(err));
        setStep('reveal');
        leave();
      })
      .finally(() => setIsSubmitting(false));
  }, [hasHardwareProtector, isSubmitting, revealMnemonic, setSecret, leave]);

  useEffect(() => {
    return () => setSecret(null);
  }, [setSecret]);

  // When secret is cleared (auto-hide after 20s), go back. Not on the warning,
  // where no secret has been asked for yet.
  useEffect(() => {
    if (step === 'reveal' && secret === null && hasHardwareProtector !== null && !isSubmitting && !showPasswordDrawer) {
      leave();
    }
  }, [step, secret, hasHardwareProtector, isSubmitting, showPasswordDrawer, leave]);

  const words = secret ? secret.split(' ') : [];

  const onPasswordSubmit = useCallback(
    async (data: FormData) => {
      if (isSubmitting) return;
      setIsSubmitting(true);
      clearErrors();
      setAuthError(null);
      try {
        const generation = secretGeneration.current;
        const mnemonic = await revealMnemonic(data.password);
        if (generation !== secretGeneration.current) return;
        setSecret(mnemonic);
        setShowPasswordDrawer(false);
      } catch (err: any) {
        await new Promise(res => setTimeout(res, 300));
        setError('password', { type: 'submit-error', message: err.message });
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, clearErrors, revealMnemonic, setSecret, setError]
  );

  const handleHide = useCallback(() => {
    hapticLight();
    setSecret(null);
    leave();
  }, [setSecret, leave]);

  const handlePasswordDrawerClose = useCallback(() => {
    setShowPasswordDrawer(false);
    leave();
  }, [leave]);

  if (seedStatus && seedStatus !== 'stored')
    return (
      <p role="status" className="p-4">
        {/* Three distinct states, not two: a removal still to finish, one that
            finished, and a wallet imported from a key that never had a phrase
            here at all. Telling that last user their seed was removed is false.
            VerifySeedPhraseFlow carries the identical mapping. */}
        {t(SEED_STATE_NOTICE[seedStatus])}
      </p>
    );

  if (step === 'warning') {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
        <PageHeader className="px-4" title={t('recoveryPhrase')} onBack={leave} focusTitleOnMount />

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col px-4">
          {/* A blurred stand-in for the word grid: the shape of the phrase, none of its words. */}
          <div aria-hidden="true" className="bg-fill rounded-2xl px-6 py-8">
            <div className="grid grid-cols-2 gap-x-6 gap-y-5">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="h-1.5 w-full rounded-full bg-fill-pressed" />
              ))}
            </div>
          </div>

          <p className="mt-4 text-center text-body text-muted">{t('pleaseWriteDownRecoveryPhrase')}</p>

          {/* The shared outcome hero, the same one the verify flow's warning step draws. */}
          <Hero
            className="mt-auto pt-8"
            visual={
              <div className="flex size-16 items-center justify-center rounded-full bg-accent-primary">
                <Icon name={IconName.EyeOff} size="md" fill="white" />
              </div>
            }
            name={t('viewThisInPrivatePlace')}
            subtitle={t('anyoneWithRecoveryPhrase')}
          />
        </div>

        <div className="flex shrink-0 gap-2.5 px-4 pt-6 pb-4">
          <Button className="flex-1" variant={ButtonVariant.Secondary} title={t('close')} onClick={leave} />
          <Button
            className="flex-1"
            variant={ButtonVariant.Primary}
            title={t('view')}
            onClick={handleView}
            disabled={hasHardwareProtector === null || isSubmitting}
            isLoading={isSubmitting}
          />
        </div>
      </div>
    );
  }

  if (hasHardwareProtector === null || (!secret && isSubmitting)) {
    return null;
  }

  // Revealed view
  if (secret && words.length > 0) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg text-ink">
        <PageHeader className="px-4" title={t('recoveryPhrase')} onBack={handleHide} />

        <div className="flex-1 flex flex-col px-4">
          {isGuardReady && (
            <>
              {/* Hidden field for copy */}
              <input ref={fieldRef} value={secret || ''} readOnly className="sr-only" tabIndex={-1} />

              {/* Copy is the shared Pill, like every other copy action in the wallet. */}
              <div className="mb-4 flex justify-center">
                <Pill
                  icon={<AnimatedCopyIcon copied={copied} className="h-full w-full" />}
                  onClick={copy}
                  data-testid="reveal-seed-copy"
                >
                  <CopyLabel copied={copied} copiedLabel={t('copied')}>
                    {t('copyToClipboard')}
                  </CopyLabel>
                </Pill>
              </div>

              {/* Word grid: the group's own `fill` surface, and each word a row value. */}
              <div className="rounded-2xl bg-fill p-5">
                <div className="grid grid-cols-3 gap-x-4 gap-y-5">
                  {words.map((word, idx) => (
                    <span key={idx} className="text-center text-value text-ink">
                      {word.charAt(0).toUpperCase() + word.slice(1)}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Hide button */}
        <div className="px-4 pb-8 pt-4 mt-auto">
          <Button
            className="w-full justify-center"
            variant={ButtonVariant.Primary}
            title={t('hideRecoveryPhrase')}
            onClick={handleHide}
          />
        </div>
      </div>
    );
  }

  // Auth error fallback
  if (authError) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
        <PageHeader className="px-4" title={t('recoveryPhrase')} onBack={leave} />
        <div className="px-4">
          <Notice tone="negative" role="alert" title={t('error')}>
            {authError}
          </Notice>
        </div>
      </div>
    );
  }

  // Passcode / password drawer (for non-hardware wallets, shown on mount).
  // Mobile vaults are protected by the 6-digit onboarding passcode, so they
  // get the numpad; extension/desktop use a typed password.
  const usePasscodeEntry = isMobile();

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
      <PageHeader className="px-4" title={t('recoveryPhrase')} onBack={leave} />

      <Drawer
        open={showPasswordDrawer}
        onOpenChange={open => !open && handlePasswordDrawerClose()}
        screenKey="reveal-seed"
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t(usePasscodeEntry ? 'enterYourPasscode' : 'password')}</DrawerTitle>
          </DrawerHeader>
          {usePasscodeEntry ? (
            <div className="px-4 pb-6">
              <PasscodeEntry
                onSubmit={code => onPasswordSubmit({ password: code })}
                onChange={() => clearErrors()}
                error={errors.password?.message ?? null}
                isSubmitting={isSubmitting}
              />
            </div>
          ) : (
            <form className="px-4 pb-6" onSubmit={handleSubmit(onPasswordSubmit)}>
              <TextField
                {...register('password', { required: t('required') })}
                label={t('password')}
                id="reveal-seed-password"
                type="password"
                placeholder="********"
                error={errors.password?.message}
                errorTestId="error-caption"
                containerClassName="mb-4"
                onChange={e => {
                  register('password').onChange(e);
                  clearErrors();
                }}
              />
              <Button
                className="w-full justify-center"
                variant={ButtonVariant.Primary}
                title={t('continue')}
                disabled={isSubmitting || !passwordValue}
                isLoading={isSubmitting}
                onClick={handleSubmit(onPasswordSubmit)}
              />
            </form>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
};

export default RevealSeedPhrase;
