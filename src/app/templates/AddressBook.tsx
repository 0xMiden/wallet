import React, { useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';
import { t } from 'i18next';

import { AddNewContactForm } from 'app/templates/AddNewContactForm';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { useContacts } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { useConfirm } from 'lib/ui/dialog';
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
    <div className="w-full mx-auto" data-testid="address-book">
      <AddNewContactForm />

      <hr className="border-border-light my-8" />

      <div className="flex flex-col gap-4">
        <span className="text-heading-gray font-medium text-base">{t('currentContacts')}</span>
        <input
          type="text"
          enterKeyHint="search"
          placeholder={t('searchContacts')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className={classNames(
            'w-full h-14 px-4',
            'bg-gray-25 border border-gray-100 rounded-10',
            'text-base placeholder:text-text-muted placeholder:font-medium',
            'outline-none focus:border-gray-100'
          )}
        />
      </div>

      <div className="flex flex-col gap-y-2 mt-4">
        {filteredContacts.length === 0 ? (
          <p className="text-center text-text-muted text-sm py-4">{t('noContactsFound')}</p>
        ) : (
          filteredContacts.map(contact => (
            <CardItem
              key={contact.address}
              data-testid={`address-book-contact-${contact.address}`}
              title={contact.name}
              subtitle={`${contact.accountInWallet ? (contact.isPublic ? t('public') : t('private')) : t('external')} · ${truncateAddress(contact.address, true, 12)}`}
              iconLeft={<Avatar image="/misc/avatars/miden-orange.png" size="lg" />}
              hoverable={!contact.accountInWallet}
              onClick={contact.accountInWallet ? undefined : () => handleRemoveContactClick(contact.address)}
              className="bg-app-bg rounded-xl h-auto py-3 px-3"
            />
          ))
        )}
      </div>
    </div>
  );
};

export default AddressBook;
