import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Button, ButtonVariant } from 'components/Button';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { AnimatedCopyIcon, CopyLabel } from 'components/ui/CopyFeedback';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SeedPhraseGrid, SeedPhrasePlaceholder, SeedPhrasePrivacyHero } from 'components/ui/SeedPhraseGrid';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
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
      // The same page the verify flow draws for this state, on the same frame.
      <SubPageLayout
        title={t('recoveryPhrase')}
        onBack={leave}
        data-testid="reveal-seed-state"
        footer={<Button className="flex-1" title={t('close')} onClick={leave} />}
      >
        {/* Three distinct states, not two: a removal still to finish, one that
            finished, and a wallet imported from a key that never had a phrase
            here at all. Telling that last user their seed was removed is false.
            VerifySeedPhraseFlow carries the identical mapping. */}
        <SubPageSection description={<p role="status">{t(SEED_STATE_NOTICE[seedStatus])}</p>} />
      </SubPageLayout>
    );

  if (step === 'warning') {
    return (
      <SubPageLayout
        title={t('recoveryPhrase')}
        onBack={leave}
        focusTitleOnMount
        data-testid="reveal-seed-warning"
        footer={
          <>
            <Button className="flex-1" variant={ButtonVariant.Secondary} title={t('close')} onClick={leave} />
            <Button
              className="flex-1"
              variant={ButtonVariant.Primary}
              title={t('view')}
              onClick={handleView}
              disabled={hasHardwareProtector === null || isSubmitting}
              isLoading={isSubmitting}
            />
          </>
        }
      >
        <SubPageSection footnote={t('pleaseWriteDownRecoveryPhrase')}>
          <SeedPhrasePlaceholder />
        </SubPageSection>

        <SeedPhrasePrivacyHero className="mt-auto pt-4" />
      </SubPageLayout>
    );
  }

  if (hasHardwareProtector === null || (!secret && isSubmitting)) {
    return null;
  }

  // Revealed view
  if (secret && words.length > 0) {
    return (
      <SubPageLayout
        title={t('recoveryPhrase')}
        onBack={handleHide}
        data-testid="reveal-seed-review"
        footer={
          <Button
            className="flex-1"
            variant={ButtonVariant.Primary}
            title={t('hideRecoveryPhrase')}
            onClick={handleHide}
          />
        }
      >
        {isGuardReady && (
          <SubPageSection className="gap-3">
            {/* Hidden field for copy */}
            <input ref={fieldRef} value={secret || ''} readOnly className="sr-only" tabIndex={-1} />

            <SeedPhraseGrid words={words} />

            {/* Copy is the shared Pill, like every other copy action in the wallet. */}
            <Pill
              className="self-start"
              icon={<AnimatedCopyIcon copied={copied} className="h-full w-full" />}
              onClick={copy}
              data-testid="reveal-seed-copy"
            >
              <CopyLabel copied={copied} copiedLabel={t('copied')}>
                {t('copyToClipboard')}
              </CopyLabel>
            </Pill>
          </SubPageSection>
        )}
      </SubPageLayout>
    );
  }

  // Auth error fallback
  if (authError) {
    return (
      <SubPageLayout title={t('recoveryPhrase')} onBack={leave} data-testid="reveal-seed-error">
        <Notice tone="negative" role="alert" title={t('error')}>
          {authError}
        </Notice>
      </SubPageLayout>
    );
  }

  // Passcode / password drawer (for non-hardware wallets, shown on mount).
  // Mobile vaults are protected by the 6-digit onboarding passcode, so they
  // get the numpad; extension/desktop use a typed password.
  const usePasscodeEntry = isMobile();

  return (
    <SubPageLayout title={t('recoveryPhrase')} onBack={leave} data-testid="reveal-seed-auth">
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
    </SubPageLayout>
  );
};

export default RevealSeedPhrase;
