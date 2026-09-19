import React, { FC, useCallback, useLayoutEffect, useRef, useState } from 'react';

import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { Button } from 'components/Button';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import { setFaucetIdSetting } from 'lib/miden/assets';

const SUBMIT_ERROR_TYPE = 'submit-error';
const FORM_ID = 'edit-miden-faucet-id-form';

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
      } catch (err: unknown) {
        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError('faucetId', { type: SUBMIT_ERROR_TYPE, message: err instanceof Error ? err.message : String(err) });
        focusFaucetIdField();
      }
    },
    [isSubmitting, clearErrors, setError, focusFaucetIdField]
  );

  return (
    <SubPageLayout
      data-testid="edit-miden-faucet-id"
      footer={
        // Outside the form (it is pinned under the body), so it names the form it submits.
        <Button type="submit" form={FORM_ID} className="flex-1 max-w-none" isLoading={isSubmitting}>
          {t('setNewFaucetId')}
        </Button>
      }
    >
      <form id={FORM_ID} ref={formRef} onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <TextField
          {...register('faucetId', { required: t('required') })}
          label={t('faucetId')}
          hint={t('setNewFaucetIdDescription')}
          id="set-faucet-id"
          type="text"
          placeholder={faucetId ?? ''}
          error={errors.faucetId?.message}
          errorTestId="edit-faucet-id-error"
          onChange={() => {
            clearErrors();
            if (submitSuccess) {
              setSubmitSuccess(false);
            }
          }}
        />

        {submitSuccess && (
          <p role="status" className="px-1 font-sans text-sm text-positive-ink">
            {t('faucetIdUpdated')}
          </p>
        )}
      </form>
    </SubPageLayout>
  );
};

export default EditMidenFaucetId;
