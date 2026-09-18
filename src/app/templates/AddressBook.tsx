import React, { useMemo, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { Button, ButtonVariant } from 'components/Button';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { SearchInput } from 'components/ui/SearchInput';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { hapticLight } from 'lib/mobile/haptics';
import { WalletContact } from 'lib/shared/types';
import { navigate } from 'lib/woozie';
import { contactNetwork, contactNetworkName } from 'screens/contacts/contact-network';
import { contactPath, NEW_CONTACT_PATH } from 'screens/contacts/contact-paths';
import { truncateAddress } from 'utils/string';

function matches(contact: WalletContact, query: string): boolean {
  return contact.name.toLowerCase().includes(query) || contact.address.toLowerCase().includes(query);
}

const byName = (a: WalletContact, b: WalletContact) => a.name.localeCompare(b.name);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2 className="px-1 pb-2 font-sans text-[13px] font-bold text-muted">{children}</h2>
);

interface RowProps {
  contact: WalletContact;
  subtitle: string;
  onClick?: () => void;
  /** Every row after the first: a hairline above it, starting after the avatar. */
  inset?: boolean;
  'data-testid': string;
}

const Row: React.FC<RowProps> = ({ contact, subtitle, onClick, inset, 'data-testid': dataTestId }) => {
  const { kind } = contactNetwork(contact.address, contact.network);
  const content = (
    <>
      {/* Only a `0x` contact gets the badge: the subtitle names every network, and a Miden badge on
          every row is noise. */}
      <ContactAvatar address={contact.address} name={contact.name} network={kind === 'ethereum' ? kind : undefined} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-heading text-base font-bold text-ink">{contact.name}</span>
        <span className="truncate font-sans text-sm text-muted">{subtitle}</span>
      </span>
    </>
  );
  const className = clsx(
    'relative flex w-full items-center gap-3 px-4 py-3 text-left',
    inset && 'before:absolute before:top-0 before:right-0 before:left-[68px] before:h-px before:bg-hairline'
  );

  return onClick ? (
    <button
      type="button"
      data-testid={dataTestId}
      onClick={() => {
        hapticLight();
        onClick();
      }}
      className={clsx(className, 'transition-colors active:bg-fill-pressed')}
    >
      {content}
      <ChevronRightIcon className="h-4 w-4 shrink-0 stroke-muted" aria-hidden="true" />
    </button>
  ) : (
    <div data-testid={dataTestId} className={className}>
      {content}
    </div>
  );
};

const Group: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-col overflow-hidden rounded-2xl bg-fill">{children}</div>
);

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
    <div className="flex w-full flex-1 flex-col" data-testid="address-book">
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t('searchContacts')}
        data-testid="address-book-search"
        className="mt-1 shrink-0"
      />

      <div className="flex flex-col gap-6 pt-6 pb-4">
        {nothingFound ? (
          <p className="py-4 text-center text-sm text-muted">{t('noContactsFound')}</p>
        ) : (
          <>
            {(contacts.length > 0 || !query) && (
              <section>
                <SectionTitle>{t('contacts')}</SectionTitle>
                {contacts.length > 0 ? (
                  <Group>
                    {contacts.map((contact, index) => (
                      <Row
                        key={contact.address}
                        contact={contact}
                        inset={index > 0}
                        subtitle={`${contactNetworkName(contact.address, contact.network, t('miden'))} · ${truncateAddress(contact.address, true, 8)}`}
                        onClick={() => navigate(contactPath(contact.address))}
                        data-testid={`address-book-contact-${contact.address}`}
                      />
                    ))}
                  </Group>
                ) : (
                  !hasSavedContacts && (
                    <div
                      data-testid="address-book-empty"
                      className="flex flex-col items-center gap-1 rounded-2xl bg-fill px-6 py-8 text-center"
                    >
                      <span className="font-heading text-base font-bold text-ink">{t('noContactsYet')}</span>
                      <span className="text-sm text-muted">{t('noContactsYetHint')}</span>
                    </div>
                  )
                )}
              </section>
            )}

            {accounts.length > 0 && (
              <section>
                <SectionTitle>{t('myAccounts')}</SectionTitle>
                <Group>
                  {accounts.map((account, index) => (
                    <Row
                      key={account.address}
                      contact={account}
                      inset={index > 0}
                      subtitle={`${account.isPublic ? t('public') : t('private')} · ${truncateAddress(account.address, true, 8)}`}
                      data-testid={`address-book-account-${account.address}`}
                    />
                  ))}
                </Group>
              </section>
            )}
          </>
        )}
      </div>

      {/* Pinned to the bottom of the scrolling page, so it stays in reach under a long list. */}
      <div className="sticky bottom-0 mt-auto bg-app-bg pt-2 pb-4">
        <Button
          title={t('newContact')}
          variant={ButtonVariant.Secondary}
          onClick={() => navigate(NEW_CONTACT_PATH)}
          data-testid="address-book-new-contact"
          className="w-full max-w-none rounded-full bg-fill text-base font-semibold text-ink"
        />
      </div>
    </div>
  );
};

export default AddressBook;
