import React, { FC, useCallback, useMemo } from 'react';

import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { ACCOUNT_NAME_PATTERN } from 'app/defaults';
import PageLayout from 'app/layouts/PageLayout';
import { useFormAnalytics } from 'lib/analytics';
import { useAccount, useMidenContext } from 'lib/miden/front';
import { navigate } from 'lib/woozie';

type FormData = {
  name: string;
};

const SUBMIT_ERROR_TYPE = 'submit-error';

const UpdateAccountName: FC = () => {
  const { t } = useTranslation();
  const { editAccountName } = useMidenContext();
  const account = useAccount();
  const formAnalytics = useFormAnalytics('ChangeAccountName');

  const defaultName = useMemo(() => account.name, [account.name]);

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isSubmitting }
  } = useForm<FormData>({
    defaultValues: { name: defaultName }
  });

  const onSubmit = useCallback<SubmitHandler<FormData>>(
    async ({ name }) => {
      if (isSubmitting) return;

      clearErrors('name');

      formAnalytics.trackSubmit();
      try {
        if (name && name !== account.name) {
          await editAccountName(account.publicKey, name);
        }

        formAnalytics.trackSubmitSuccess();

        navigate('/');
      } catch (err: any) {
        formAnalytics.trackSubmitFail();

        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError('name', { type: SUBMIT_ERROR_TYPE, message: err.message });
      }
    },
    [account.name, account.publicKey, isSubmitting, clearErrors, setError, editAccountName, formAnalytics]
  );

  return (
    <PageLayout pageTitle={<>{t('editAccountName')}</>}>
      <div className="w-full max-w-sm mx-auto mt-6 px-4" style={{ height: '420px' }}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <FormField
            {...register('name', {
              pattern: {
                value: ACCOUNT_NAME_PATTERN,
                message: t('accountNameInputTitle')
              }
            })}
            label={
              <div className="font-medium -mb-2" style={{ fontSize: '14px', lineHeight: '20px' }}>
                {t('accountName')}
              </div>
            }
            id="edit-account-name"
            type="text"
            name="name"
            placeholder={defaultName}
            errorCaption={errors.name?.message}
          />

          <FormSubmitButton
            className="capitalize w-full justify-center mt-8"
            loading={isSubmitting}
            style={{
              fontSize: '18px',
              lineHeight: '24px',
              paddingLeft: '0.5rem',
              paddingRight: '0.5rem',
              paddingTop: '12px',
              paddingBottom: '12px'
            }}
          >
            {t('save')}
          </FormSubmitButton>
        </form>
      </div>
    </PageLayout>
  );
};

export default UpdateAccountName;
