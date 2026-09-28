import React, { HTMLAttributes, memo, ReactNode } from 'react';

import classNames from 'clsx';

import AddressShortView from 'app/atoms/AddressShortView';
import Name from 'app/atoms/Name';
import { Icon, IconName } from 'app/icons/v2';
import { Card } from 'components/ui/Card';
import { WalletAccount } from 'lib/shared/types';

type AccountBannerProps = HTMLAttributes<HTMLDivElement> & {
  account: WalletAccount;
  displayBalance?: boolean;
  networkRpc?: string;
  label?: ReactNode;
  labelDescription?: ReactNode;
  labelIndent?: 'sm' | 'md';
};

const AccountBanner = memo<AccountBannerProps>(({ className, account }) => {
  return (
    <div className={classNames('flex flex-col mt-4', className)}>
      <Card padding="tile" className="flex w-full items-center">
        {/* wallet.svg uses currentColor; #484848 is the pre-conversion light color and
            vanishes on the dark card, so dark takes the muted ink instead. */}
        <Icon name={IconName.Wallet} fill="currentColor" size="sm" className="text-gray-250 dark:text-text-muted" />

        <div className="flex items-center ml-3 text-sm">
          <Name className="text-ink mr-3">{account.name}</Name>
          <AddressShortView address={account.publicKey} />
        </div>
      </Card>
    </div>
  );
});

export default AccountBanner;
