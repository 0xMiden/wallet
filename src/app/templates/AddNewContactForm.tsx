import React, { useCallback } from 'react';

import classNames from 'clsx';
import { t } from 'i18next';
import { useForm } from 'react-hook-form';

import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { useContacts, isAddressValid } from 'lib/miden/front';
import { withErrorHumanDelay } from 'lib/ui/humanDelay';

type ContactFormData = {
  address: string;
  name: string;
};

const SUBMIT_ERROR_TYPE = 'submit-error';

export interface AddNewContactFormProps {
  className?: string;
  /** Pre-fills the address field, e.g. the recipient typed in the send flow. Stays editable. */
  defaultAddress?: string;
  /** Hide the "Add Contact" heading where the surrounding surface already titles the form. */
  hideHeading?: boolean;
  /** Called after the contact is persisted — used by the send flow to close its drawer. */
  onAdded?: (address: string) => void;
}

/**
 * The single add-contact form. Owned by the Settings address book and reused as
 * the body of the send flow's "Add to contacts?" bottom sheet, so address
 * validation and the `addContact` write live in exactly one place.
 */
export const AddNewContactForm: React.FC<AddNewContactFormProps> = ({
  className,
  defaultAddress,
  hideHeading,
  onAdded
}) => {
  const { addContact } = useContacts();

  const {
    register,
    reset: resetForm,
    handleSubmit,
    clearErrors,
    setError,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<ContactFormData>({ defaultValues: { address: defaultAddress ?? '', name: '' } });

  const addressValue = watch('address');
  const nameValue = watch('name');
  const isFormEmpty = !addressValue || !nameValue;

  const onAddContactSubmit = useCallback(
    async ({ address, name }: ContactFormData) => {
      if (isSubmitting) return;

      try {
        clearErrors();

        if (!isAddressValid(address)) {
          throw new Error(t('invalidAddress'));
        }

        await addContact({ address, name, addedAt: Date.now() });
        resetForm();
        onAdded?.(address);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await withErrorHumanDelay(err, () => setError('address', { type: SUBMIT_ERROR_TYPE, message }));
      }
    },
    [isSubmitting, clearErrors, addContact, resetForm, onAdded, setError]
  );

  return (
    <form className={classNames('flex flex-col', className)} onSubmit={handleSubmit(onAddContactSubmit)}>
      <div className="flex flex-col gap-4">
        {!hideHeading && <span className="text-heading-gray font-medium text-base">{t('addContact')}</span>}
        <FormField
          {...register('name', {
            required: t('required'),
            maxLength: { value: 50, message: t('maximalAmount', { amount: '50' }) }
          })}
          id="name"
          name="name"
          data-testid="address-book-name-input"
          placeholder={t('enterUsername')}
          errorCaption={errors.name?.message}
          containerClassName="bg-gray-25 border-gray-100 border rounded-10"
          maxLength={50}
          className="font-sans bg-gray-25 h-14 active:border-none focus:border-none  placeholder:text-text-muted placeholder:font-medium rounded-10"
          fieldWrapperBottomMargin={false}
        />
        <FormField
          {...register('address', {
            required: t('required'),
            maxLength: { value: 50, message: t('maximalAmount', { amount: '50' }) }
          })}
          id="address"
          name="address"
          data-testid="address-book-address-input"
          placeholder={t('enterAddress')}
          errorCaption={errors.address?.message}
          className="font-sans bg-gray-25 h-14 active:border-none focus:border-none placeholder:text-text-muted rounded-10"
          fieldWrapperBottomMargin={false}
          containerClassName="bg-gray-25 border-gray-100 border rounded-10"
        />
      </div>
      <FormSubmitButton
        className="capitalize w-full justify-center mt-7 rounded-10 text-base font-semibold h-14"
        loading={isSubmitting}
        disabled={isFormEmpty}
        testID="AddressBook/AddNewContact"
        data-testid="address-book-add-contact"
      >
        {t('addContact')}
      </FormSubmitButton>
    </form>
  );
};
