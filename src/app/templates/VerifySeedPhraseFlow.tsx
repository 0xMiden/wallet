import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { Vault } from 'lib/miden/back/vault';
import { useMidenContext } from 'lib/miden/front';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { completeWalletPrompt, WalletPromptType } from 'lib/wallet-prompts';
import { goBack, navigate } from 'lib/woozie';
import { VerifySeedPhraseScreen } from 'screens/onboarding/create-wallet-flow/VerifySeedPhrase';

type Step = 'warning' | 'auth' | 'review' | 'quiz';

type FormData = {
  password: string;
};

const VerifySeedPhraseFlow: FC = () => {
  const { t } = useTranslation();
  const { revealMnemonic } = useMidenContext();
  const [step, setStep] = useState<Step>('warning');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    clearErrors,
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
      try {
        const phrase = await revealMnemonic(password);
        setMnemonic(phrase);
        setStep('review');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (password === undefined) {
          setAuthError(message);
        } else {
          await new Promise(res => setTimeout(res, 300));
          setError('password', { type: 'submit-error', message });
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [clearErrors, isSubmitting, revealMnemonic, setError]
  );

  const onWarningContinue = useCallback(() => {
    hapticMedium();
    if (hasHardwareProtector) {
      revealPhrase(undefined);
      return;
    }
    setStep('auth');
  }, [hasHardwareProtector, revealPhrase]);

  const onPasswordSubmit = useCallback((data: FormData) => revealPhrase(data.password), [revealPhrase]);

  const onComplete = useCallback(async () => {
    hapticMedium();
    await completeWalletPrompt(WalletPromptType.VerifySeedPhrase);
    setMnemonic(null);
    navigate('/');
  }, []);

  const onExit = useCallback(() => {
    hapticLight();
    setMnemonic(null);
    goBack();
  }, []);

  if (step === 'warning') {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
        <NavigationHeader title={t('verifySeedPhrase')} onBack={onExit} />
        <div className="flex-1 flex flex-col">
          <div className="mt-6 px-4">
            <div className="bg-gray-25 rounded-2xl px-6 py-8">
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 place-items-center">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className="h-1.5 rounded-full bg-gray-50" style={{ width: 144 }} />
                ))}
              </div>
            </div>

            <div className="mt-4 bg-white rounded-xl p-4 text-center">
              <p className="text-sm text-heading-gray">{t('verifySeedPhraseWarningBody')}</p>
            </div>
            {authError && (
              <Alert type="error" title={t('error')} description={authError} className="mt-4 rounded-lg text-black" />
            )}
          </div>

          <div className="mt-auto pt-6 pb-6 flex flex-col items-center text-center bg-white rounded-t-2xl">
            <div className="flex flex-col px-6 items-center">
              <div className="w-10 h-10 rounded-sm bg-primary-500 flex items-center justify-center mb-4">
                <Icon name={IconName.EyeOff} size="md" fill="white" />
              </div>

              <h3 className="text-base font-medium text-black mb-1">{t('viewThisInPrivatePlace')}</h3>
              <p className="text-sm text-black mb-8 font-medium">{t('anyoneWithRecoveryPhrase')}</p>
            </div>
            <div className="flex gap-4 w-full px-4">
              <Button
                className="flex-1 justify-center"
                variant={ButtonVariant.Secondary}
                title={t('close')}
                onClick={onExit}
              />
              <Button
                className="flex-1 justify-center"
                variant={ButtonVariant.Primary}
                title={t('continue')}
                onClick={onWarningContinue}
                disabled={hasHardwareProtector === null || isSubmitting}
                isLoading={isSubmitting}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'auth') {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
        <NavigationHeader title={t('verifySeedPhrase')} onBack={() => setStep('warning')} />
        <form className="flex-1 flex flex-col px-4 pt-4 pb-6" onSubmit={handleSubmit(onPasswordSubmit)}>
          <div className="flex flex-col gap-2 mb-6">
            <h1 className="text-2xl font-semibold text-heading-gray">{t('enterPassword')}</h1>
            <p className="text-sm text-text-muted">{t('verifySeedPhrasePasswordBody')}</p>
          </div>
          <FormField
            {...passwordField}
            label={t('password')}
            id="verify-seed-phrase-password"
            type="password"
            name="password"
            placeholder="********"
            errorCaption={errors.password?.message}
            onChange={e => {
              passwordField.onChange(e);
              clearErrors();
            }}
            containerClassName="mb-4"
            labelClassName="text-black"
          />
          <div className="mt-auto">
            <Button
              className="w-full justify-center"
              variant={ButtonVariant.Primary}
              title={t('continue')}
              disabled={isSubmitting || !passwordValue}
              isLoading={isSubmitting}
              onClick={handleSubmit(onPasswordSubmit)}
            />
          </div>
        </form>
      </div>
    );
  }

  if (step === 'review' && words.length === 12) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg text-heading-gray">
        <NavigationHeader title={t('recoveryPhrase')} onBack={onExit} />
        <div className="flex-1 flex flex-col px-4 pt-4 pb-6">
          <p className="text-sm text-text-muted text-center mb-4">{t('verifySeedPhraseReviewBody')}</p>

          <div className="p-6 bg-white rounded-10">
            <div className="grid grid-cols-3 gap-x-4 gap-y-5">
              {words.map((word, idx) => (
                <div key={idx} className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-text-muted w-5 text-right">{idx + 1}.</span>
                  <span className="text-sm font-medium text-heading-gray truncate">{word}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-auto">
            <Button
              className="w-full justify-center"
              variant={ButtonVariant.Primary}
              title={t('continue')}
              onClick={() => setStep('quiz')}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
      <NavigationHeader title={t('verifySeedPhrase')} onBack={() => setStep('review')} />
      <VerifySeedPhraseScreen
        seedPhrase={words}
        showIntro={false}
        onSubmit={onComplete}
        className="min-h-0 pt-6"
        data-testid="verify-seed-phrase-prompt-flow"
      />
    </div>
  );
};

export default VerifySeedPhraseFlow;
