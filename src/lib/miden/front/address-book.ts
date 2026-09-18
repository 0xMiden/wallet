import { useCallback } from 'react';

import { getMessage } from 'lib/i18n';
import { useMidenContext } from 'lib/miden/front';
import { WalletContact } from 'lib/shared/types';

import { useFilteredContacts } from './use-filtered-contacts.hook';

export function useContacts() {
  const { updateSettings } = useMidenContext();
  const { contacts, allContacts } = useFilteredContacts();

  const addContact = useCallback(
    async (cToAdd: WalletContact) => {
      // Case-insensitive: a checksummed `0x` address and its lowercase form are the same account.
      const address = cToAdd.address.trim().toLowerCase();
      if (allContacts.some(c => c.address.trim().toLowerCase() === address)) {
        throw new Error(getMessage('contactWithTheSameAddressAlreadyExists'));
      }
      await updateSettings({
        contacts: [cToAdd, ...contacts]
      });
    },
    [contacts, allContacts, updateSettings]
  );

  const removeContact = useCallback(
    async (address: string) =>
      await updateSettings({
        contacts: contacts.filter(c => c.address !== address)
      }),
    [contacts, updateSettings]
  );

  // Only the name and a `0x` contact's network are editable: the address is the contact's identity.
  const updateContact = useCallback(
    async (address: string, changes: Pick<WalletContact, 'name' | 'network'>) =>
      await updateSettings({
        contacts: contacts.map(c => (c.address === address ? { ...c, ...changes } : c))
      }),
    [contacts, updateSettings]
  );

  const getContact = useCallback(
    (address: string) => allContacts.find(c => c.address === address) ?? null,
    [allContacts]
  );

  return {
    addContact,
    updateContact,
    removeContact,
    getContact
  };
}

export const CONTACT_FIELDS_TO_SEARCH = ['name', 'address'] as const;
