import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { EmptyState } from 'components/ui/EmptyState';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Pill } from 'components/ui/Pill';
import { SearchInput } from 'components/ui/SearchInput';
import { SectionHeader } from 'components/ui/SectionHeader';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { contactNetwork, contactNetworkName } from 'screens/contacts/contact-network';
import { truncateAddress } from 'utils/string';

import { Contact } from './types';

export interface AccountsListDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientAccountId?: string;
  accounts: Contact[];
  onSelectContact: (contact: Contact) => void;
}

function matches(contact: Contact, query: string): boolean {
  return contact.name.toLowerCase().includes(query) || contact.id.toLowerCase().includes(query);
}

/**
 * Contact picker for the send flow, presented as a bottom sheet (vaul) over
 * the recipient step instead of a pushed sub-screen. One search over the
 * wallet's own accounts and the saved contacts, in that order, each in its own
 * section. Fixed at a comfortable height even when the list is short — mirrors
 * SelectTokenDrawer.
 */
export const AccountsListDrawer: React.FC<AccountsListDrawerProps> = ({
  open,
  onOpenChange,
  recipientAccountId,
  accounts,
  onSelectContact
}) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const query = searchQuery.trim().toLowerCase();

  // The component stays mounted while the sheet is closed, so a search would
  // otherwise still be applied the next time it opens.
  useEffect(() => {
    if (!open) setSearchQuery('');
  }, [open]);

  const { mine, contacts } = useMemo(() => {
    const visible = query ? accounts.filter(c => matches(c, query)) : accounts;
    return { mine: visible.filter(c => c.isOwned), contacts: visible.filter(c => !c.isOwned) };
  }, [accounts, query]);

  const renderRow = (contact: Contact, subtitle: string) => (
    <ListRow
      key={contact.id}
      title={contact.name}
      subtitle={subtitle}
      avatar={
        <ContactAvatar
          address={contact.id}
          name={contact.name}
          // Only a `0x` contact gets the badge: the subtitle names every network.
          network={contactNetwork(contact.id, contact.network).kind === 'ethereum' ? 'ethereum' : undefined}
        />
      }
      trailing={contact.isGuardian ? <Pill size="sm">{t('guardianBadge')}</Pill> : undefined}
      checked={contact.id === recipientAccountId}
      onClick={() => {
        onSelectContact(contact);
        onOpenChange(false);
      }}
      data-testid={`send-contact-${contact.id}`}
    />
  );

  // SendManager's back handler closes this sheet, so the sheet does not register its own.
  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="accounts" closeOnBack={false}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('addressBook')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex h-120 min-h-0 flex-col px-4 pb-4" data-testid="send-contacts-list">
          {accounts.length === 0 ? (
            <EmptyState
              data-testid="send-contacts-empty"
              className="flex-1"
              icon={IconName.Users}
              title={t('noOtherAccounts')}
              description={t('noOtherAccountsDescription')}
            />
          ) : (
            <>
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={t('searchContacts')}
                data-testid="send-contacts-search"
                className="shrink-0"
              />
              <div className="no-scrollbar flex min-h-0 flex-col gap-5 overflow-y-auto pt-5">
                {mine.length === 0 && contacts.length === 0 ? (
                  <p className="py-4 text-center text-body-sm text-muted">{t('noContactsFound')}</p>
                ) : (
                  <>
                    {mine.length > 0 && (
                      <section>
                        <SectionHeader>{t('myAccounts')}</SectionHeader>
                        <ListGroup>
                          {mine.map(c => renderRow(c, `${t(c.contactType)} · ${truncateAddress(c.id, true, 8)}`))}
                        </ListGroup>
                      </section>
                    )}
                    {contacts.length > 0 && (
                      <section>
                        <SectionHeader>{t('contacts')}</SectionHeader>
                        <ListGroup>
                          {contacts.map(c =>
                            renderRow(
                              c,
                              `${contactNetworkName(c.id, c.network, t('miden'))} · ${truncateAddress(c.id, true, 8)}`
                            )
                          )}
                        </ListGroup>
                      </section>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};
