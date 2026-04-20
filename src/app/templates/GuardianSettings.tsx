import React, { FC, useCallback, useEffect, useState } from 'react';

import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { DEFAULT_PSM_ENDPOINT } from 'lib/miden-chain/constants';
import {
  initiateSwitchGuardianTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { fetchFromStorage, onStorageChanged } from 'lib/miden/front';
import { isExtension } from 'lib/platform';
import { PSM_URL_STORAGE_KEY } from 'lib/settings/constants';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';

type FormData = {
  guardianEndpoint: string;
};

const URL_PATTERN = /^https?:\/\/.+/i;

type Props = {
  onClose?: () => void;
};

const GuardianSettings: FC<Props> = ({ onClose }) => {
  const { t } = useTranslation();
  const { endpoint: currentEndpoint, refresh: refreshCurrentEndpoint } = useCurrentGuardianEndpoint();
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<FormData>({ defaultValues: { guardianEndpoint: '' } });

  const currentAccount = useWalletStore(s => s.currentAccount);

  const onSubmit = useCallback<SubmitHandler<FormData>>(
    async ({ guardianEndpoint }) => {
      if (isSubmitting || !currentAccount) return;
      const trimmed = guardianEndpoint.trim();
      if (trimmed === currentEndpoint) {
        setError('guardianEndpoint', { type: 'manual', message: t('guardianEndpointUnchanged') });
        return;
      }

      clearErrors();
      setSubmitSuccess(false);

      try {
        const txId = await initiateSwitchGuardianTransaction(
          currentAccount.publicKey,
          trimmed,
          isDelegateProofEnabled()
        );
        useWalletStore.getState().openTransactionModal();
        if (isExtension()) requestSWTransactionProcessing();

        const result = await waitForTransactionCompletion(txId);
        if ('errorMessage' in result) {
          setError('guardianEndpoint', { type: 'manual', message: result.errorMessage });
          return;
        }

        setSubmitSuccess(true);
        reset({ guardianEndpoint: '' });
        // Pull the new endpoint back from storage so the "Current guardian"
        // display reflects the switch on platforms without storage-change events.
        refreshCurrentEndpoint();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError('guardianEndpoint', { type: 'manual', message });
      }
    },
    [clearErrors, currentAccount, currentEndpoint, isSubmitting, refreshCurrentEndpoint, reset, setError, t]
  );

  return (
    <div className="w-full max-w-sm p-2 mx-auto">
      <div className="mb-4">
        <p className="text-sm text-heading-gray font-medium mb-1">{t('currentGuardianEndpoint')}</p>
        <p className="text-sm text-black break-all select-text">{currentEndpoint || t('loading')}</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)}>
        <FormField
          {...register('guardianEndpoint', {
            required: t('required'),
            pattern: { value: URL_PATTERN, message: t('invalidUrl') }
          })}
          label={t('newGuardianEndpoint')}
          labelDescription={t('switchGuardianDescription')}
          id="guardian-endpoint"
          type="text"
          placeholder="https://"
          errorCaption={errors.guardianEndpoint?.message}
          containerClassName="mb-4"
          onChange={() => {
            clearErrors();
            if (submitSuccess) setSubmitSuccess(false);
          }}
        />

        <FormSubmitButton
          className="capitalize w-full justify-center mt-6"
          loading={isSubmitting}
          disabled={!currentAccount}
          style={{
            fontSize: '18px',
            lineHeight: '24px',
            paddingLeft: '0.5rem',
            paddingRight: '0.5rem',
            paddingTop: '12px',
            paddingBottom: '12px'
          }}
        >
          {t('switchGuardian')}
        </FormSubmitButton>

        {submitSuccess && (
          <div className="mt-4 text-green-600 text-sm font-medium" onAnimationEnd={() => onClose?.()}>
            {t('guardianSwitched')}
          </div>
        )}
      </form>
    </div>
  );
};

export default GuardianSettings;

function useCurrentGuardianEndpoint(): { endpoint: string; refresh: () => void } {
  const [endpoint, setEndpoint] = useState<string>('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchFromStorage<string>(PSM_URL_STORAGE_KEY)
      .then(stored => {
        if (cancelled) return;
        setEndpoint(stored || DEFAULT_PSM_ENDPOINT);
      })
      .catch(() => {
        if (cancelled) return;
        setEndpoint(DEFAULT_PSM_ENDPOINT);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Extension builds get storage-change events for free; on mobile/desktop this
  // is a no-op and the explicit refresh() call after switch handles the update.
  useEffect(
    () =>
      onStorageChanged<string>(PSM_URL_STORAGE_KEY, next => {
        setEndpoint(next || DEFAULT_PSM_ENDPOINT);
      }),
    []
  );

  return { endpoint, refresh };
}
