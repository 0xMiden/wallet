import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { EmptyState } from 'components/ui/EmptyState';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SearchInput } from 'components/ui/SearchInput';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { WalletContact } from 'lib/shared/types';
import { navigate } from 'lib/woozie';
import { contactNetwork, contactNetworkName } from 'screens/contacts/contact-network';
import { contactPath, NEW_CONTACT_PATH } from 'screens/contacts/contact-paths';
import { truncateAddress } from 'utils/string';

function matches(contact: WalletContact, query: string): boolean {
  return contact.name.toLowerCase().includes(query) || contact.address.toLowerCase().includes(query);
}

const byName = (a: WalletContact, b: WalletContact) => a.name.localeCompare(b.name);

/** Only a `0x` contact gets the badge: the subtitle names every network, and a Miden badge on every row is noise. */
function avatarFor(contact: WalletContact): React.ReactNode {
  const { kind } = contactNetwork(contact.address, contact.network);
  return (
    <ContactAvatar address={contact.address} name={contact.name} network={kind === 'ethereum' ? kind : undefined} />
  );
}

/**
 * Settings → Address Book: saved contacts, then the wallet's own accounts, with one search over
 * both. A contact opens its own page (send, rename, delete); adding one is its own page too, so
 * this screen is only the list.
 */
const AddressBook: React.FC = () => {
  const { t } = useTranslation();
  const { allContacts } = useFilteredContacts();
  const [searchQuery, setSearchQuery] = useState('');
  const query = searchQuery.trim().toLowerCase();

  const { contacts, accounts } = useMemo(() => {
    const visible = query ? allContacts.filter(c => matches(c, query)) : allContacts;
    return {
      contacts: visible.filter(c => !c.accountInWallet).sort(byName),
      accounts: visible.filter(c => c.accountInWallet)
    };
  }, [allContacts, query]);

  const hasSavedContacts = allContacts.some(c => !c.accountInWallet);
  const nothingFound = Boolean(query) && contacts.length === 0 && accounts.length === 0;

  return (
    <SubPageLayout
      data-testid="address-book"
      footer={
        <Button
          title={t('newContact')}
          variant={ButtonVariant.Secondary}
          onClick={() => navigate(NEW_CONTACT_PATH)}
          data-testid="address-book-new-contact"
          className="flex-1 max-w-none"
        />
      }
    >
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t('searchContacts')}
        data-testid="address-book-search"
        className="shrink-0"
      />

      {nothingFound ? (
        <EmptyState icon={IconName.ContactsBook} title={t('noContactsFound')} data-testid="address-book-no-results" />
      ) : (
        <>
          {(contacts.length > 0 || !query) && (
            <SubPageSection title={t('contacts')} icon={<Icon name={IconName.ContactsBook} fill="currentColor" />}>
              {contacts.length > 0 ? (
                <ListGroup surface="plain">
                  {contacts.map(contact => (
                    <ListRow
                      key={contact.address}
                      title={contact.name}
                      avatar={avatarFor(contact)}
                      subtitle={`${contactNetworkName(contact.address, contact.network, t('miden'))} · ${truncateAddress(contact.address, true, 8)}`}
                      onClick={() => navigate(contactPath(contact.address))}
                      chevron
                      data-testid={`address-book-contact-${contact.address}`}
                    />
                  ))}
                </ListGroup>
              ) : (
                !hasSavedContacts && (
                  <EmptyState
                    data-testid="address-book-empty"
                    icon={IconName.ContactsBook}
                    title={t('noContactsYet')}
                    description={t('noContactsYetHint')}
                  />
                )
              )}
            </SubPageSection>
          )}

          {accounts.length > 0 && (
            <SubPageSection title={t('myAccounts')} icon={<Icon name={IconName.Wallet} fill="currentColor" />}>
              <ListGroup surface="plain">
                {accounts.map(account => (
                  <ListRow
                    key={account.address}
                    title={account.name}
                    avatar={avatarFor(account)}
                    subtitle={`${account.isPublic ? t('public') : t('private')} · ${truncateAddress(account.address, true, 8)}`}
                    data-testid={`address-book-account-${account.address}`}
                  />
                ))}
              </ListGroup>
            </SubPageSection>
          )}
        </>
      )}
    </SubPageLayout>
  );
};

export default AddressBook;
