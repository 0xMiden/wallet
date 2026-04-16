import React, { FC, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { setFaucetIdSetting } from 'lib/miden/assets';

const SUBMIT_ERROR_TYPE = 'submit-error';

type FormData = {
  faucetId: string;
};

const EditMidenFaucetId: FC = () => {
  const { t } = useTranslation();
  const faucetId = useMidenFaucetId();
  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isSubmitting }
  } = useForm<FormData>();
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);
  const focusFaucetIdField = useCallback(() => {
    formRef.current?.querySelector<HTMLInputElement>("input[name='faucetId']")?.focus();
  }, []);

  useLayoutEffect(() => {
    focusFaucetIdField();
  }, [focusFaucetIdField]);

  const onSubmit = useCallback<SubmitHandler<FormData>>(
    async ({ faucetId }) => {
      if (isSubmitting) return;
      clearErrors('faucetId');
      setSubmitSuccess(false);

      try {
        await setFaucetIdSetting(faucetId);
        setSubmitSuccess(true);
      } catch (err: any) {
        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError('faucetId', { type: SUBMIT_ERROR_TYPE, message: err.message });
        focusFaucetIdField();
      }
    },
    [isSubmitting, clearErrors, setError, focusFaucetIdField]
  );

  const content = useMemo(() => {
    return (
      <form ref={formRef} onSubmit={handleSubmit(onSubmit)}>
        <FormField
          {...register('faucetId', { required: t('required') })}
          label={t('faucetId')}
          labelDescription={t('setNewFaucetIdDescription')}
          id="set-faucet-id"
          type="text"
          name="faucetId"
          placeholder={faucetId}
          errorCaption={errors.faucetId?.message}
          containerClassName="mb-4"
          onChange={() => {
            clearErrors();
            if (submitSuccess) {
              setSubmitSuccess(false);
            }
          }}
        />

        <FormSubmitButton
          className="capitalize w-full justify-center mt-6"
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
          {t('setNewFaucetId')}
        </FormSubmitButton>

        {submitSuccess && <div className="mt-4 text-green-600 text-sm font-medium">{t('faucetIdUpdated')}</div>}
      </form>
    );
  }, [faucetId, errors, handleSubmit, onSubmit, register, isSubmitting, clearErrors, submitSuccess, t]);

  return <div className="w-full max-w-sm p-2 mx-auto">{content}</div>;
};

export default EditMidenFaucetId;
