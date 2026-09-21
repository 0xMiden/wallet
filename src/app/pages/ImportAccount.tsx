import React, { FC, ReactNode, useCallback, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { ACCOUNT_NAME_PATTERN } from 'app/defaults';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Button } from 'components/Button';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import { useMidenContext } from 'lib/miden/front';
import { clearClipboard } from 'lib/ui/util';
import { navigate } from 'lib/woozie';

interface ImportAccountForm {
  privateKey: string;
  name?: string;
}

// The submit button is pinned under the body, outside the form, so it names the form it submits.
const FORM_ID = 'import-account-form';

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
    <SubPageLayout
      title={t('importAccount')}
      onBack={goBack}
      focusTitleOnMount
      footer={
        <Button
          type="submit"
          form={FORM_ID}
          data-testid="import-account-submit"
          className="flex-1"
          isLoading={isSubmitting}
          disabled={isSubmitting}
        >
          {t('importAccount')}
        </Button>
      }
    >
      {error && (
        <Notice tone="negative" role="alert" title={t('error')} data-testid="import-account-error">
          {error}
        </Notice>
      )}

      <form
        id={FORM_ID}
        data-testid="import-account-form"
        className="flex flex-col gap-5"
        onSubmit={handleSubmit(onSubmit)}
      >
        {/* `secret`: a pasted private key is covered again as soon as the field is left. */}
        <TextField
          {...register('privateKey', { required: t('required') })}
          multiline
          secret
          rows={2}
          id="importacc-privatekey"
          aria-label={t('privateKey')}
          label={t('privateKey')}
          hint={t('privateKeyInputDescription')}
          placeholder={t('privateKeyInputPlaceholder')}
          error={errors.privateKey?.message}
          className="font-sans"
          onPaste={clearClipboard}
        />

        <TextField
          {...register('name', {
            pattern: { value: ACCOUNT_NAME_PATTERN, message: t('accountNameInputInvalid') },
            setValueAs: (value: string) => value.trim()
          })}
          id="importacc-name"
          aria-label={t('accountName')}
          label={t('accountName')}
          placeholder={t('accountNameInputPlaceholder')}
          error={errors.name?.message}
        />
      </form>
    </SubPageLayout>
  );
};

export default ImportAccount;
