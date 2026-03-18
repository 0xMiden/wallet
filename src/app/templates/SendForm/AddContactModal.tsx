import React, { FC, useCallback } from 'react';

import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import AddressShortView from 'app/atoms/AddressShortView';
import AnimalIdenticon from 'app/atoms/AnimalIdenticon';
import FormField from 'app/atoms/FormField';
import FormSecondaryButton from 'app/atoms/FormSecondaryButton';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import ModalWithTitle from 'app/templates/ModalWithTitle';
import { withErrorHumanDelay } from 'lib/ui/humanDelay';

type AddContactModalProps = {
  address: string | null;
  onClose: () => void;
};

const AddContactModal: FC<AddContactModalProps> = ({ address, onClose }) => {
  const { t } = useTranslation();
  const {
    register,
    reset: resetForm,
    handleSubmit,
    clearErrors,
    setError,
    formState: { errors, isSubmitting }
  } = useForm<{ name: string }>();

  const onAddContactSubmit = useCallback(
    async ({ name }: { name: string }) => {
      if (isSubmitting) return;

      try {
        clearErrors();

        resetForm();
        onClose();
      } catch (err: any) {
        await withErrorHumanDelay(err, () => setError('name', { type: 'submit-error', message: err.message }));
      }
    },
    [isSubmitting, clearErrors, resetForm, onClose, setError]
  );

  return (
    <ModalWithTitle isOpen={Boolean(address)} title={t('addNewContact')} onRequestClose={onClose}>
      <form onSubmit={handleSubmit(onAddContactSubmit)}>
        <div className="mb-8">
          <div className="mb-4 flex items-stretch border rounded-md p-2">
            <AnimalIdenticon publicKey={address ?? ''} size={32} className="shrink-0 shadow-xs" />

            <div className="ml-3 flex-1 flex items-center">
              <span className={classNames('text-black text-black')}>
                <AddressShortView address={address ?? ''} />
              </span>
            </div>
          </div>

          <FormField
            {...register('name', {
              required: t('required'),
              maxLength: { value: 50, message: t('maximalAmount', { amount: '50' }) }
            })}
            label={t('name')}
            id="name"
            name="name"
            placeholder={t('newContactPlaceholder')}
            errorCaption={errors.name?.message}
            containerClassName="mb-6"
            maxLength={50}
          />
        </div>
        <div className="flex justify-end">
          <FormSecondaryButton type="button" small className="mr-3" onClick={onClose}>
            {t('cancel')}
          </FormSecondaryButton>
          <FormSubmitButton small loading={isSubmitting}>
            {t('addContact')}
          </FormSubmitButton>
        </div>
      </form>
    </ModalWithTitle>
  );
};

export default AddContactModal;
