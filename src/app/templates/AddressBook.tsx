import React, { useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';
import { t } from 'i18next';
import { useForm } from 'react-hook-form';

import FormField from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { useContacts, isAddressValid } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { isMobile } from 'lib/platform';
import { useConfirm } from 'lib/ui/dialog';
import { withErrorHumanDelay } from 'lib/ui/humanDelay';
import { truncateAddress } from 'utils/string';

const AddressBook: React.FC = () => {
  const { removeContact } = useContacts();
  const { allContacts } = useFilteredContacts();
  const confirm = useConfirm();
  const [searchQuery, setSearchQuery] = useState('');

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

  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return allContacts;
    const query = searchQuery.toLowerCase();
    return allContacts.filter(c => c.name.toLowerCase().includes(query) || c.address.toLowerCase().includes(query));
  }, [allContacts, searchQuery]);

  return (
    <div className="w-full mx-auto">
      <AddNewContactForm />

      <hr className="border-gray-300 my-8" />

      <div className="flex flex-col gap-4">
        <span className="text-heading-gray font-medium text-xl">{t('currentContacts')}</span>
        <input
          type="text"
          placeholder={t('searchContacts')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className={classNames(
            'w-full h-14 px-4',
            'bg-gray-25 border border-gray-100 rounded-10',
            'text-base placeholder:text-gray-600 placeholder:font-medium',
            'outline-none focus:border-gray-100'
          )}
        />
      </div>

      <div className="flex flex-col gap-y-2 mt-4">
        {filteredContacts.length === 0 ? (
          <p className="text-center text-grey-600 text-sm py-4">{t('noContactsFound')}</p>
        ) : (
          filteredContacts.map(contact => (
            <CardItem
              key={contact.address}
              title={contact.name}
              subtitle={`${contact.accountInWallet ? (contact.isPublic ? t('public') : t('private')) : t('external')} · ${truncateAddress(contact.address, true, 12)}`}
              iconLeft={<Avatar image="/misc/avatars/miden-orange.png" size="lg" />}
              hoverable={!contact.accountInWallet}
              onClick={contact.accountInWallet ? undefined : () => handleRemoveContactClick(contact.address)}
              className="bg-grey-25 rounded-xl h-auto py-3 px-3"
            />
          ))
        )}
      </div>
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
    watch,
    formState: { errors, isSubmitting }
  } = useForm<ContactFormData>();

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
      } catch (err: any) {
        await withErrorHumanDelay(err, () => setError('address', { type: SUBMIT_ERROR_TYPE, message: err.message }));
      }
    },
    [isSubmitting, clearErrors, addContact, resetForm, setError]
  );

  return (
    <form
      className={classNames('flex flex-col', isMobile() ? 'pt-8' : 'pt-4', className)}
      onSubmit={handleSubmit(onAddContactSubmit)}
    >
      <div className="flex flex-col gap-4">
        <span className="text-heading-gray font-medium text-xl">{t('addContact')}</span>
        <FormField
          {...register('name', {
            required: t('required'),
            maxLength: { value: 50, message: t('maximalAmount', { amount: '50' }) }
          })}
          id="name"
          name="name"
          placeholder={t('enterUsername')}
          errorCaption={errors.name?.message}
          containerClassName="bg-gray-25 border-gray-100 border rounded-10"
          maxLength={50}
          className="bg-gray-25 h-14 active:border-none focus:border-none  placeholder:text-gray-600 placeholder:font-medium rounded-10"
          fieldWrapperBottomMargin={false}
        />
        <FormField
          {...register('address', {
            required: t('required'),
            maxLength: { value: 50, message: t('maximalAmount', { amount: '50' }) }
          })}
          id="address"
          name="address"
          placeholder={t('enterAddress')}
          errorCaption={errors.address?.message}
          autoFocus
          className="bg-gray-25 h-14 active:border-none focus:border-none placeholder:text-gray-600 rounded-10"
          fieldWrapperBottomMargin={false}
          containerClassName="bg-gray-25 border-gray-100 border rounded-10"
        />
      </div>
      <FormSubmitButton
        className="capitalize w-full justify-center mt-7 rounded-10 text-base font-semibold h-14"
        loading={isSubmitting}
        disabled={isFormEmpty}
        testID="AddressBook/AddNewContact"
      >
        {t('addContact')}
      </FormSubmitButton>
    </form>
  );
};
