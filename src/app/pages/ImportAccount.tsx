import React, { FC, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import NoSpaceField from 'app/atoms/NoSpaceField';
import TabSwitcher from 'app/atoms/TabSwitcher';
import PageLayout from 'app/layouts/PageLayout';
import { useNativeNavbarAction } from 'lib/dapp-browser';
import { useMidenContext, useAllAccounts } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

import { clearClipboard } from '../../lib/ui/util';

type ImportAccountProps = {
  tabSlug: string | null;
};

interface ImportTabDescriptor {
  slug: string;
  i18nKey: string;
  Form: FC<{}>;
}

const ImportAccount: FC<ImportAccountProps> = ({ tabSlug }) => {
  const { t } = useTranslation();
  const allAccounts = useAllAccounts();
  const { updateCurrentAccount } = useMidenContext();

  const prevAccLengthRef = useRef(allAccounts.length);
  useEffect(() => {
    const accLength = allAccounts.length;
    if (prevAccLengthRef.current < accLength) {
      updateCurrentAccount(allAccounts[accLength - 1].publicKey);
      navigate('/');
    }
    prevAccLengthRef.current = accLength;
  }, [allAccounts, updateCurrentAccount]);

  const allTabs = useMemo(
    () =>
      [
        {
          slug: 'private-key',
          i18nKey: 'privateKey',
          Form: ByPrivateKeyForm
        },
        {
          slug: 'watch-only',
          i18nKey: 'watchOnlyAccount',
          Form: WatchOnlyForm
        }
      ].filter((x): x is ImportTabDescriptor => !!x),
    []
  );
  const { slug, Form } = useMemo(() => {
    const tab = tabSlug ? allTabs.find(currentTab => currentTab.slug === tabSlug) : null;
    return tab ?? allTabs[0];
  }, [allTabs, tabSlug]);

  return (
    <PageLayout
      pageTitle={
        <>
          <span className="capitalize">{t('importAccount')}</span>
        </>
      }
    >
      <div className="p-4">
        <TabSwitcher className="m-4" tabs={allTabs} activeTabSlug={slug} urlPrefix="/import-account" />

        <Form />
      </div>
    </PageLayout>
  );
};

export default ImportAccount;

interface ByPrivateKeyFormData {
  privateKey: string;
  encPassword?: string;
}

const ByPrivateKeyForm: FC = () => {
  const { t } = useTranslation();
  const { importAccount } = useMidenContext();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<ByPrivateKeyFormData>();
  const [error, setError] = useState<ReactNode>(null);

  const onSubmit = useCallback(
    async ({ privateKey, encPassword }: ByPrivateKeyFormData) => {
      if (isSubmitting) return;

      setError(null);
      try {
        await importAccount(privateKey.replace(/\s/g, ''), encPassword);
      } catch (err: any) {
        console.error(err);

        // Human delay
        await new Promise(r => setTimeout(r, 300));
        setError(err.message);
      }
    },
    [importAccount, isSubmitting, setError]
  );

  useNativeNavbarAction({
    label: t('importAccount'),
    onTap: handleSubmit(onSubmit),
    enabled: !isSubmitting
  });

  return (
    <form className="w-full max-w-sm mx-auto my-8" onSubmit={handleSubmit(onSubmit)} style={{ minHeight: '325px' }}>
      {error && <Alert type="error" title={t('error')} autoFocus description={error} className="mb-6" />}

      <FormField
        {...register('privateKey', { required: t('required') })}
        secret
        textarea
        rows={1}
        name="privateKey"
        id="importacc-privatekey"
        label={
          <div className="font-medium -mb-2" style={{ fontSize: '14px', lineHeight: '20px' }}>
            {t('privateKey')}
          </div>
        }
        placeholder={t('privateKeyInputPlaceholder')}
        errorCaption={errors.privateKey?.message}
        className="resize-none"
        onPaste={() => clearClipboard()}
      />
      <div className="mb-6 text-gray-200" style={{ fontSize: '12px', lineHeight: '16px' }}>
        {t('privateKeyInputDescription')}
      </div>
      {!isMobile() && (
        <FormSubmitButton
          className="capitalize w-full justify-center"
          style={{
            fontSize: '18px',
            lineHeight: '24px',
            paddingLeft: '0.5rem',
            paddingRight: '0.5rem',
            paddingTop: '12px',
            paddingBottom: '12px'
          }}
          loading={isSubmitting}
        >
          {t('importAccount')}
        </FormSubmitButton>
      )}
    </form>
  );
};

interface WatchOnlyFormData {
  viewKey: string;
}

const WatchOnlyForm: FC = () => {
  const { t } = useTranslation();
  const { importWatchOnlyAccount } = useMidenContext();

  const {
    handleSubmit,
    control,
    setValue,
    getValues,
    trigger,
    formState: { errors, isSubmitting }
  } = useForm<WatchOnlyFormData>({
    mode: 'onChange'
  });
  const [error, setError] = useState<ReactNode>(null);

  const addressFieldRef = useRef<HTMLTextAreaElement>(null);

  const cleanViewKeyField = useCallback(() => {
    setValue('viewKey', '');
    trigger('viewKey');
  }, [setValue, trigger]);

  const onSubmit = useCallback(
    async ({ viewKey }: WatchOnlyFormData) => {
      if (isSubmitting) return;

      setError(null);

      try {
        await importWatchOnlyAccount(viewKey);
      } catch (err: any) {
        console.error(err);

        // Human delay
        await new Promise(r => setTimeout(r, 300));
        setError(err.message);
      }
    },
    [importWatchOnlyAccount, isSubmitting, setError]
  );

  useNativeNavbarAction({
    label: t('importAccount'),
    onTap: handleSubmit(onSubmit),
    enabled: !isSubmitting
  });

  return (
    <form className="w-full max-w-sm mx-auto my-8" onSubmit={handleSubmit(onSubmit)} style={{ minHeight: '325px' }}>
      {error && <Alert type="error" title={t('error')} description={error} autoFocus className="mb-6" />}

      <Controller
        name="viewKey"
        control={control}
        rules={{
          required: true,
          validate: () => true
        }}
        render={({ field }) => (
          <NoSpaceField
            {...field}
            ref={addressFieldRef}
            onFocus={() => addressFieldRef.current?.focus()}
            textarea
            rows={1}
            cleanable={Boolean(getValues().viewKey)}
            onClean={cleanViewKeyField}
            id="watch-viewKey"
            label={
              <div className="font-medium -mb-2" style={{ fontSize: '14px', lineHeight: '20px' }}>
                {t('viewKeyWatchOnly')}
              </div>
            }
            placeholder={t('viewKeyInputPlaceholder')}
            errorCaption={errors.viewKey?.message}
            className="resize-none"
          />
        )}
      />
      <div className="mb-6 text-gray-200" style={{ fontSize: '12px', lineHeight: '16px' }}>
        {t('viewKeyInputDescription')}
      </div>

      {!isMobile() && (
        <FormSubmitButton
          className="capitalize w-full justify-center"
          style={{
            fontSize: '18px',
            lineHeight: '24px',
            paddingLeft: '0.5rem',
            paddingRight: '0.5rem',
            paddingTop: '12px',
            paddingBottom: '12px'
          }}
          loading={isSubmitting}
        >
          {t('importAccount')}
        </FormSubmitButton>
      )}
    </form>
  );
};
