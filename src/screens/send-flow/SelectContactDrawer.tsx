import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { EmptyState } from 'components/EmptyState';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { truncateAddress } from 'utils/string';

import { Contact } from './types';

export interface SelectContactDrawerProps {
  open: boolean;
  onClose: () => void;
  recipientAccountId?: string;
  accounts: Contact[];
  onSelectContact: (contact: Contact) => void;
}

export const SelectContactDrawer: React.FC<SelectContactDrawerProps> = ({
  open,
  onClose,
  recipientAccountId,
  accounts,
  onSelectContact
}) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={isOpen => !isOpen && onClose()}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('contacts')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-4 gap-y-2">
          {accounts.length === 0 ? (
            <EmptyState
              className="flex-1 py-8"
              icon={IconName.Users}
              title={t('noOtherAccounts')}
              description={t('noOtherAccountsDescription')}
            />
          ) : (
            accounts.map(c => (
              <CardItem
                key={c.id}
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
                onClick={() => onSelectContact(c)}
                hoverable={true}
              />
            ))
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};
