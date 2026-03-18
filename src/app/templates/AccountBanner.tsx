import React, { HTMLAttributes, memo, ReactNode } from 'react';

import classNames from 'clsx';

import AddressShortView from 'app/atoms/AddressShortView';
import Name from 'app/atoms/Name';
import { Icon, IconName } from 'app/icons/v2';
import { WalletAccount } from 'lib/shared/types';

type AccountBannerProps = HTMLAttributes<HTMLDivElement> & {
  account?: WalletAccount;
  displayBalance?: boolean;
  networkRpc?: string;
  label?: ReactNode;
  labelDescription?: ReactNode;
  labelIndent?: 'sm' | 'md';
};

const AccountBanner = memo<AccountBannerProps>(({ className, account }) => {
  return (
    <div className={classNames('flex flex-col mt-4', className)}>
      <div className={classNames('w-full', 'border border-gray-100 rounded-2xl', 'p-4', 'flex items-center')}>
        <Icon name={IconName.Wallet} fill="currentColor" size="sm" />

        <div className="flex items-center ml-3 text-sm">
          <Name className="text-gray-600 mr-3">{account!.name}</Name>
          <AddressShortView address={account!.publicKey} />
        </div>
      </div>
    </div>
  );
});

export default AccountBanner;
