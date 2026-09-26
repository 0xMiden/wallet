import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { AnimatedCopyIcon } from 'components/ui/AnimatedCopyIcon';
import { CopyLabel } from 'components/ui/CopyLabel';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SeedPhraseGrid, SeedPhrasePlaceholder, SeedPhrasePrivacyHero } from 'components/ui/SeedPhraseGrid';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import { COPY_FEEDBACK_MS } from 'lib/animation/copy';
import { Vault } from 'lib/miden/back/vault';
import { useMidenContext } from 'lib/miden/front';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { completeWalletPrompt, WalletPromptType } from 'lib/wallet-prompts';
import { goBack, navigate } from 'lib/woozie';
import { VerifySeedPhraseScreen } from 'screens/onboarding/create-wallet-flow/VerifySeedPhrase';

import { SEED_STATE_NOTICE } from './seed-state-notice';

type Step = 'warning' | 'auth' | 'review' | 'quiz' | 'confirm';

type FormData = {
  password: string;
};

const VerifySeedPhraseFlow: FC<{ remove?: boolean }> = ({ remove = false }) => {
  const { t } = useTranslation();
  const { revealMnemonic, removeSeedPhrase } = useMidenContext();
  const secretGeneration = useRef(0);
  const seedStatus = useWalletStore(s => s.seedPhraseStatus);
  useEffect(
    () => () => {
      secretGeneration.current += 1;
    },
    [seedStatus]
  );
  const [credential, setCredential] = useState<string>();
  const [step, setStep] = useState<Step>('warning');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const { fieldRef, copy, copied } = useCopyToClipboard(COPY_FEEDBACK_MS);

  // Block screenshots/recordings while the phrase is revealed (#417). The
  // phrase is only rendered once the guard reports the screen is protected.
  const isGuardReady = useScreenshotGuard(mnemonic !== null);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    clearErrors,
    reset,
    formState: { errors }
  } = useForm<FormData>();
  const passwordField = register('password', { required: t('required') });
  const passwordValue = watch('password');

  useEffect(() => {
    let cancelled = false;
    Vault.hasHardwareProtector()
      .then(hasHardware => {
        if (!cancelled) setHasHardwareProtector(hasHardware);
      })
      .catch(() => {
        if (!cancelled) setHasHardwareProtector(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const words = useMemo(() => mnemonic?.split(' ').filter(Boolean) ?? [], [mnemonic]);

  useEffect(() => {
    if ((step === 'review' || step === 'quiz') && words.length !== 12) {
      setStep('warning');
    }
  }, [step, words.length]);

  const revealPhrase = useCallback(
    async (password?: string) => {
      if (isSubmitting) return;
      setIsSubmitting(true);
      setAuthError(null);
      clearErrors();
      const generation = secretGeneration.current;
      try {
        const phrase = await revealMnemonic(password);
        if (generation !== secretGeneration.current) return;
        setMnemonic(phrase);
        if (remove) setCredential(password);
        setStep('review');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (password === undefined) {
          if (generation !== secretGeneration.current) return;
          setAuthError(message);
        } else {
          await new Promise(res => setTimeout(res, 300));
          // After the delay: the user can back out while it runs.
          if (generation !== secretGeneration.current) return;
          setError('password', { type: 'submit-error', message });
        }
      } finally {
        // Unguarded: isSubmitting allows one reveal at a time, so this always resets it.
        setIsSubmitting(false);
      }
    },
    [clearErrors, isSubmitting, revealMnemonic, setError, remove]
  );

  const onWarningContinue = useCallback(() => {
    hapticMedium();
    if (hasHardwareProtector) {
      revealPhrase(undefined);
      return;
    }
    // A submit's react-hook-form completion can land after backToWarning's reset
    // and reinstate isSubmitted, so reset again on the way back into auth.
    reset();
    setStep('auth');
  }, [hasHardwareProtector, revealPhrase, reset]);

  const onPasswordSubmit = useCallback((data: FormData) => revealPhrase(data.password), [revealPhrase]);

  const onComplete = useCallback(async () => {
    hapticMedium();
    if (remove) {
      setMnemonic(null);
      setStep('confirm');
      return;
    }
    await completeWalletPrompt(WalletPromptType.VerifySeedPhrase);
    setMnemonic(null);
    navigate('/');
  }, [remove]);

  // Leaving the attempt, by any exit, abandons an in-flight reveal, so its late result
  // cannot move the flow on or leave an error or password behind for the next attempt.
  const abandonReveal = useCallback(() => {
    secretGeneration.current += 1;
  }, []);

  const backToWarning = useCallback(() => {
    abandonReveal();
    reset();
    setStep('warning');
  }, [abandonReveal, reset]);

  const onExit = useCallback(() => {
    abandonReveal();
    hapticLight();
    setMnemonic(null);
    setCredential(undefined);
    goBack();
  }, [abandonReveal]);

  useMobileBackHandler(() => {
    onExit();
    return true;
  }, [onExit]);

  useEffect(() => {
    if (seedStatus && seedStatus !== 'stored') {
      setMnemonic(null);
      setCredential(undefined);
    }
  }, [seedStatus]);

  const onRemove = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setAuthError(null);
    try {
      await removeSeedPhrase(credential);
      setMnemonic(null);
      setCredential(undefined);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : t('seedRemovalFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const actionButton = 'flex-1 max-w-none';

  if (seedStatus && seedStatus !== 'stored') {
    return (
      <SubPageLayout
        title={t('recoveryPhrase')}
        onBack={onExit}
        data-testid="verify-seed-state"
        footer={<Button className={actionButton} title={t('close')} onClick={onExit} />}
      >
        <SubPageSection description={<p role="status">{t(SEED_STATE_NOTICE[seedStatus])}</p>}>
          <ErrorLine>{authError}</ErrorLine>
        </SubPageSection>
      </SubPageLayout>
    );
  }

  if (step === 'confirm') {
    return (
      <SubPageLayout
        title={t('removeSeedPhrase')}
        onBack={onExit}
        data-testid="remove-seed-confirm"
        footer={
          <>
            <Button className={actionButton} title={t('cancel')} variant={ButtonVariant.Secondary} onClick={onExit} />
            {/* Destructive: after this the wallet keeps no copy of the phrase. */}
            <Button
              className={actionButton}
              title={t('removeSeedPhraseConfirm')}
              variant={ButtonVariant.Destructive}
              onClick={onRemove}
              disabled={isSubmitting}
              isLoading={isSubmitting}
            />
          </>
        }
      >
        <SubPageSection description={t('removeSeedPhraseConfirmation')}>
          <ErrorLine>{authError}</ErrorLine>
        </SubPageSection>
      </SubPageLayout>
    );
  }

  if (step === 'warning') {
    return (
      <SubPageLayout
        title={t('verifySeedPhrase')}
        onBack={onExit}
        data-testid="verify-seed-warning"
        footer={
          <>
            <Button className={actionButton} variant={ButtonVariant.Secondary} title={t('close')} onClick={onExit} />
            <Button
              className={actionButton}
              variant={ButtonVariant.Primary}
              title={t('continue')}
              onClick={onWarningContinue}
              disabled={hasHardwareProtector === null || isSubmitting}
              isLoading={isSubmitting}
            />
          </>
        }
      >
        <SubPageSection description={t(remove ? 'removeSeedPhraseDescription' : 'verifySeedPhraseWarningBody')}>
          <SeedPhrasePlaceholder />
          {authError && (
            <Notice tone="negative" role="alert" title={t('error')} className="mt-3">
              {authError}
            </Notice>
          )}
        </SubPageSection>

        <SeedPhrasePrivacyHero className="mt-auto pt-4" />
      </SubPageLayout>
    );
  }

  if (step === 'auth') {
    // Mobile vaults are protected by the 6-digit onboarding passcode, so they
    // get the numpad; extension/desktop use a typed password.
    if (isMobile()) {
      return (
        <SubPageLayout title={t('verifySeedPhrase')} onBack={backToWarning} data-testid="verify-seed-auth">
          <SubPageSection title={t('enterYourPasscode')} description={t('verifySeedPhrasePasswordBody')} />
          <PasscodeEntry
            onSubmit={code => revealPhrase(code)}
            onChange={() => clearErrors()}
            error={errors.password?.message ?? null}
            isSubmitting={isSubmitting}
            className="mt-auto pb-2"
          />
        </SubPageLayout>
      );
    }

    return (
      <SubPageLayout
        title={t('verifySeedPhrase')}
        onBack={backToWarning}
        data-testid="verify-seed-auth"
        footer={
          <Button
            className={actionButton}
            variant={ButtonVariant.Primary}
            title={t('continue')}
            disabled={isSubmitting || !passwordValue}
            isLoading={isSubmitting}
            onClick={handleSubmit(onPasswordSubmit)}
          />
        }
      >
        <SubPageSection title={t('enterPassword')} description={t('verifySeedPhrasePasswordBody')}>
          {/* One password field and no submit button: Enter submits the form on its own. */}
          <form onSubmit={handleSubmit(onPasswordSubmit)}>
            <TextField
              {...passwordField}
              label={t('password')}
              id="verify-seed-phrase-password"
              type="password"
              placeholder="********"
              error={errors.password?.message}
              errorTestId="verify-seed-password-error"
              onChange={e => {
                passwordField.onChange(e);
                clearErrors();
              }}
            />
          </form>
        </SubPageSection>
      </SubPageLayout>
    );
  }

  if (step === 'review' && words.length === 12) {
    return (
      <SubPageLayout
        title={t('recoveryPhrase')}
        onBack={onExit}
        data-testid="verify-seed-review"
        footer={
          <Button
            className={actionButton}
            variant={ButtonVariant.Primary}
            title={t('continue')}
            onClick={() => setStep('quiz')}
          />
        }
      >
        <SubPageSection description={t(remove ? 'removeSeedPhraseWriteDown' : 'verifySeedPhraseReviewBody')}>
          {isGuardReady && (
            <>
              <input ref={fieldRef} value={mnemonic ?? ''} readOnly className="sr-only" tabIndex={-1} />

              <SeedPhraseGrid words={words} />

              {!remove && (
                <Pill
                  className="mt-3 self-start"
                  icon={<AnimatedCopyIcon copied={copied} className="h-full w-full" />}
                  onClick={copy}
                  data-testid="verify-seed-copy"
                >
                  <CopyLabel copied={copied} copiedLabel={t('copied')}>
                    {t('copyToClipboard')}
                  </CopyLabel>
                </Pill>
              )}
            </>
          )}
        </SubPageSection>
      </SubPageLayout>
    );
  }

  return (
    <SubPageLayout title={t('verifySeedPhrase')} onBack={() => setStep('review')} data-testid="verify-seed-quiz">
      <SubPageSection
        description={
          <>
            <p>{t('verifyMessagePrefix')}</p>
            <p>
              <Trans i18nKey="verifyMessageSuffix" components={{ b: <span className="font-bold text-ink" /> }} />
            </p>
          </>
        }
      />
      {isGuardReady && (
        <VerifySeedPhraseScreen
          seedPhrase={words}
          showIntro={false}
          onSubmit={onComplete}
          data-testid="verify-seed-phrase-prompt-flow"
        />
      )}
    </SubPageLayout>
  );
};

export default VerifySeedPhraseFlow;
