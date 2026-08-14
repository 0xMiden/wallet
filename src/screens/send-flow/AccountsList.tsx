import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { EmptyState } from 'components/EmptyState';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { truncateAddress } from 'utils/string';

import { Contact } from './types';

export interface AccountsListDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientAccountId?: string;
  accounts: Contact[];
  onSelectContact: (contact: Contact) => void;
}

/**
 * Contact picker for the send flow, presented as a bottom sheet (vaul) over
 * the recipient step instead of a pushed sub-screen. Fixed at a comfortable
 * height even when the contact list is short — mirrors SelectTokenDrawer.
 */
export const AccountsListDrawer: React.FC<AccountsListDrawerProps> = ({
  open,
  onOpenChange,
  recipientAccountId,
  accounts,
  onSelectContact
}) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('contacts')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col min-h-0 px-4 pb-4 h-120" data-testid="send-contacts-list">
          {accounts.length === 0 ? (
            <EmptyState
              data-testid="send-contacts-empty"
              className="flex-1"
              icon={IconName.Users}
              title={t('noOtherAccounts')}
              description={t('noOtherAccountsDescription')}
            />
          ) : (
            <div className="flex flex-col min-h-0 overflow-y-auto no-scrollbar gap-y-2">
              {accounts.map(c => (
                <CardItem
                  key={c.id}
                  data-testid={`send-contact-${c.id}`}
                  title={c.name}
                  subtitle={`${t(c.contactType)} · ${truncateAddress(c.id)}`}
                  iconLeft={<Avatar image="/misc/avatars/miden-orange.png" size="lg" />}
                  iconRight={c.id === recipientAccountId ? IconName.CheckboxCircleFill : undefined}
                  titleRight={
                    c.isGuardian ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full text-[#CC5200] bg-[#FFF3EB]">
                        {t('guardianBadge')}
                      </span>
                    ) : undefined
                  }
                  onClick={() => {
                    onSelectContact(c);
                    onOpenChange(false);
                  }}
                  hoverable={true}
                />
              ))}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};
