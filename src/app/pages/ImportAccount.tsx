import React, { FC, ReactNode, useCallback, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { ACCOUNT_NAME_PATTERN } from 'app/defaults';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { PageHeader } from 'components/PageHeader';
import { useMidenContext } from 'lib/miden/front';
import { clearClipboard } from 'lib/ui/util';
import { navigate } from 'lib/woozie';

interface ImportAccountForm {
  privateKey: string;
  name?: string;
}

const ImportAccount: FC = () => {
  const { t } = useTranslation();
  const { importAccount, updateCurrentAccount } = useMidenContext();
  const goBack = useBackWithFallback('/');
  const [error, setError] = useState<ReactNode>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<ImportAccountForm>();

  const onSubmit = useCallback(
    async ({ privateKey, name }: ImportAccountForm) => {
      if (isSubmitting) return;

      setError(null);
      try {
        const accountPublicKey = await importAccount(privateKey.replace(/\s/g, ''), name?.trim() || undefined);
        await updateCurrentAccount(accountPublicKey);
        navigate('/');
      } catch (cause) {
        // A backend message is never shown: it is untranslated and can carry
        // internal detail. The cause is logged instead, without the key itself.
        console.error('Private key import failed:', cause);
        setError(t('smthWentWrong'));
      }
    },
    [importAccount, isSubmitting, t, updateCurrentAccount]
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-app-bg">
      <PageHeader className="px-4" title={t('importAccount')} onBack={goBack} focusTitleOnMount />
      <form
        data-testid="import-account-form"
        className="flex flex-1 min-h-0 flex-col overflow-y-auto px-4 pb-6"
        onSubmit={handleSubmit(onSubmit)}
      >
        {error && <Alert type="error" title={t('error')} autoFocus description={error} className="mb-4" />}
        <FormField
          {...register('privateKey', { required: t('required') })}
          id="importacc-privatekey"
          aria-label={t('privateKey')}
          label={t('privateKey')}
          labelDescription={t('privateKeyInputDescription')}
          placeholder={t('privateKeyInputPlaceholder')}
          errorCaption={errors.privateKey?.message}
          secret
          textarea
          rows={2}
          className="resize-none font-sans"
          onPaste={clearClipboard}
        />
        <FormField
          {...register('name', {
            pattern: { value: ACCOUNT_NAME_PATTERN, message: t('accountNameInputInvalid') },
            setValueAs: (value: string) => value.trim()
          })}
          id="importacc-name"
          aria-label={t('accountName')}
          label={t('accountName')}
          placeholder={t('accountNameInputPlaceholder')}
          errorCaption={errors.name?.message}
          containerClassName="mt-4"
        />
        <FormSubmitButton
          data-testid="import-account-submit"
          className="mt-auto w-full justify-center"
          loading={isSubmitting}
          disabled={isSubmitting}
        >
          {t('importAccount')}
        </FormSubmitButton>
      </form>
    </div>
  );
};

export default ImportAccount;
