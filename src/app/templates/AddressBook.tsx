import React, { useCallback, useMemo } from 'react';

import classNames from 'clsx';
import { t } from 'i18next';
import { useForm } from 'react-hook-form';

import ColorIdenticon from 'app/atoms/ColorIdenticon';
import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import Name from 'app/atoms/Name';
import { useAppEnv } from 'app/env';
import { ReactComponent as CloseIcon } from 'app/icons/close.svg';
import { useContacts, isAddressValid } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { WalletContact } from 'lib/shared/types';
import { useConfirm } from 'lib/ui/dialog';
import { withErrorHumanDelay } from 'lib/ui/humanDelay';

import AddressChip from './AddressChip';
import CustomSelect, { OptionRenderProps } from './CustomSelect';

type ContactActions = {
  remove: (address: string) => void;
};

const AddressBook: React.FC = () => {
  const { fullPage } = useAppEnv();
  const { removeContact } = useContacts();
  const { allContacts } = useFilteredContacts();
  const confirm = useConfirm();

  const handleRemoveContactClick = useCallback(
    async (address: string) => {
      if (
        !(await confirm({
          title: t('actionConfirmation'),
          children: t('deleteContactConfirm')
        }))
      ) {
        return;
      }

      await removeContact(address);
    },
    [confirm, removeContact]
  );

  const contactActions = useMemo<ContactActions>(
    () => ({
      remove: handleRemoveContactClick
    }),
    [handleRemoveContactClick]
  );

  return (
    <div className="w-full max-w-sm pb-4 mx-auto">
      <AddNewContactForm className="mt-4 mb-6 gap-4" />

      <hr className="border-gray-300 mb-6" />

      <div className="mb-4 flex flex-col">
        <span className="text-black font-semibold text-lg">{t('currentContacts')}</span>
      </div>
      <CustomSelect
        actions={contactActions}
        className={fullPage ? 'mb-6' : ''}
        getItemId={getContactKey}
        items={allContacts}
        OptionIcon={ContactIcon}
        OptionContent={ContactContent}
        light
        hoverable={false}
        maxHeight={fullPage ? '300px' : '160px'}
      />
    </div>
  );
};

export default AddressBook;

type ContactFormData = {
  address: string;
  name: string;
};

const SUBMIT_ERROR_TYPE = 'submit-error';

const AddNewContactForm: React.FC<{ className?: string }> = ({ className }) => {
  const { addContact } = useContacts();

  const {
    register,
    reset: resetForm,
    handleSubmit,
    clearErrors,
    setError,
    formState: { errors, isSubmitting }
  } = useForm<ContactFormData>();

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
      } catch (err: any) {
        await withErrorHumanDelay(err, () => setError('address', { type: SUBMIT_ERROR_TYPE, message: err.message }));
      }
    },
    [isSubmitting, clearErrors, addContact, resetForm, setError]
  );

  return (
    <form className={classNames('flex flex-col', className)} onSubmit={handleSubmit(onAddContactSubmit)}>
      <span className="text-black font-semibold text-lg mb-2">{t('addContact')}</span>
      <FormField
        {...register('address', {
          required: t('required'),
          maxLength: { value: 50, message: t('maximalAmount', { amount: '50' }) }
        })}
        id="address"
        name="address"
        placeholder={'Address'}
        errorCaption={errors.address?.message}
        autoFocus
        className="border-gray-500 border"
      />

      <FormField
        {...register('name', {
          required: t('required'),
          maxLength: { value: 50, message: t('maximalAmount', { amount: '50' }) }
        })}
        id="name"
        name="name"
        placeholder={'Name'}
        errorCaption={errors.name?.message}
        containerClassName="mb-2"
        maxLength={50}
        className="border-gray-500 border"
      />

      <FormSubmitButton
        className="capitalize w-full justify-center mt-7 rounded-10 text-base font-semibold py-4.5"
        loading={isSubmitting}
        testID="AddressBook/AddNewContact"
        style={{
          paddingTop: '18px',
          paddingBottom: '18px'
        }}
      >
        {t('addContact')}
      </FormSubmitButton>
    </form>
  );
};

const ContactIcon: React.FC<OptionRenderProps<WalletContact, string, ContactActions>> = ({ item }) => (
  <ColorIdenticon publicKey={item.address} className="shrink-0" />
);

const ContactContent: React.FC<OptionRenderProps<WalletContact, string, ContactActions>> = ({ item, actions }) => (
  <div className="flex flex-1 w-full">
    <div className="flex flex-col justify-between flex-1">
      <Name className="mb-px text-sm font-medium leading-tight text-left">{item.name}</Name>

      <div className="text-xs  leading-tight text-black">
        <AddressChip address={item.address} small />
      </div>
    </div>

    {item.accountInWallet ? (
      <div className="flex items-center">
        <span
          className={classNames(
            'mx-1',
            'rounded-md',
            'border-2',
            'px-2 py-1',
            'leading-tight',
            'border-gray-800 bg-gray-800 text-black',
            'font-medium'
          )}
          style={{ fontSize: '0.6rem' }}
        >
          {t('ownAccount')}
        </span>
      </div>
    ) : (
      <button
        className={classNames('flex-none p-2', 'text-black hover:text-black', 'transition ease-in-out duration-200')}
        onClick={evt => {
          evt.stopPropagation();
          actions?.remove(item.address);
        }}
      >
        <CloseIcon className="w-auto h-5 stroke-current stroke-2" title={t('delete')} />
      </button>
    )}
  </div>
);

function getContactKey(contact: WalletContact) {
  return contact.address;
}
