import React, { FC, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { Vault } from 'lib/miden/back/vault';
import { useMidenContext, useSecretState } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { goBack } from 'lib/woozie';

type FormData = {
  password: string;
};

const RevealSeedPhrase: FC = () => {
  const { t } = useTranslation();
  const { revealMnemonic } = useMidenContext();
  const { fieldRef, copy, copied } = useCopyToClipboard();
  const [secret, setSecret] = useSecretState();
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [showPasswordDrawer, setShowPasswordDrawer] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setError,
    clearErrors
  } = useForm<FormData>();

  const passwordValue = watch('password');

  // Detect auth type and auto-trigger on mount
  useEffect(() => {
    Vault.hasHardwareProtector().then(hasHw => {
      setHasHardwareProtector(hasHw);
      if (hasHw) {
        // Auto-trigger biometric auth for hardware-backed
        setIsSubmitting(true);
        revealMnemonic(undefined)
          .then(mnemonic => setSecret(mnemonic))
          .catch((err: any) => {
            setAuthError(err.message);
            goBack();
          })
          .finally(() => setIsSubmitting(false));
      } else {
        // Show password drawer for password-backed
        setShowPasswordDrawer(true);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => setSecret(null);
  }, [setSecret]);

  // When secret is cleared (auto-hide after 20s), go back
  useEffect(() => {
    if (secret === null && hasHardwareProtector !== null && !isSubmitting && !showPasswordDrawer) {
      goBack();
    }
  }, [secret, hasHardwareProtector, isSubmitting, showPasswordDrawer]);

  const words = secret ? secret.split(' ') : [];

  const onPasswordSubmit = useCallback(
    async (data: FormData) => {
      if (isSubmitting) return;
      setIsSubmitting(true);
      clearErrors();
      setAuthError(null);
      try {
        const mnemonic = await revealMnemonic(data.password);
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
    goBack();
  }, [setSecret]);

  const handlePasswordDrawerClose = useCallback(() => {
    setShowPasswordDrawer(false);
    goBack();
  }, []);

  if (hasHardwareProtector === null || (!secret && isSubmitting)) {
    return null;
  }

  // Revealed view
  if (secret && words.length > 0) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg text-heading-gray">
        <NavigationHeader title={t('recoveryPhrase')} onBack={handleHide} />

        <div className="flex-1 flex flex-col px-4 pt-4">
          {/* Hidden field for copy */}
          <input ref={fieldRef} value={secret || ''} readOnly className="sr-only" tabIndex={-1} />

          {/* Copy button */}
          <div className="flex justify-center mb-4">
            <button
              type="button"
              onClick={() => {
                hapticLight();
                copy();
              }}
              className={classNames(
                'flex items-center gap-1.5 px-4 py-1.5',
                'border border-[#00000033] rounded-2xl',
                'text-sm font-medium text-heading-gray',
                'hover:opacity-80 cursor-pointer'
              )}
            >
              <Icon name={copied ? IconName.CheckboxCircleFill : IconName.FileCopy} size="xs" />
              {t(copied ? 'copied' : 'copyToClipboard')}
            </button>
          </div>

          {/* Word grid */}
          <div className="p-6">
            <div className="grid grid-cols-4 gap-x-4 gap-y-6">
              {words.map((word, idx) => (
                <span key={idx} className="text-base font-medium text-heading-gray text-center">
                  {word.charAt(0).toUpperCase() + word.slice(1)}
                </span>
              ))}
            </div>
          </div>
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
        <NavigationHeader title={t('recoveryPhrase')} onBack={() => goBack()} />
        <div className="px-4 pt-4">
          <Alert type="error" title={t('error')} description={authError} className="rounded-lg text-black" />
        </div>
      </div>
    );
  }

  // Password drawer (for password-backed, shown on mount)
  return (
    <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
      <NavigationHeader title={t('recoveryPhrase')} onBack={() => goBack()} />

      <Drawer open={showPasswordDrawer} onOpenChange={open => !open && handlePasswordDrawerClose()}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('password')}</DrawerTitle>
          </DrawerHeader>
          <form className="px-4 pb-10" onSubmit={handleSubmit(onPasswordSubmit)}>
            <FormField
              {...register('password', { required: t('required') })}
              label={t('password')}
              id="reveal-seed-password"
              type="password"
              name="password"
              placeholder="********"
              errorCaption={errors.password?.message}
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
        </DrawerContent>
      </Drawer>
    </div>
  );
};

export default RevealSeedPhrase;
