import React, { HTMLAttributes } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { EmptyState } from 'components/EmptyState';
import { NavigationHeader } from 'components/NavigationHeader';
import { truncateAddress } from 'utils/string';

import { Contact } from './types';

export interface AccountsListProps extends HTMLAttributes<HTMLDivElement> {
  recipientAccountId?: string;
  accounts: Contact[];
  onSelectContact: (contact: Contact) => void;
  onClose: () => void;
}

export const AccountsList: React.FC<AccountsListProps> = ({
  className,
  recipientAccountId,
  accounts,
  onSelectContact,
  onClose,
  ...props
}) => {
  const { t } = useTranslation();

  return (
    <div {...props} className={classNames('flex-1 flex flex-col', className)}>
      <NavigationHeader mode="close" title={t('contacts')} onClose={onClose} showBorder />
      <div className="flex flex-col flex-1 p-4 gap-y-2 md:w-[460px] md:mx-auto">
        {accounts.length === 0 ? (
          <EmptyState
            className="flex-1"
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
              onClick={() => onSelectContact(c)}
              hoverable={true}
            />
          ))
        )}
      </div>
    </div>
  );
};
