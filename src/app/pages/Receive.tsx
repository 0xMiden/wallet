import React from 'react';

import classNames from 'clsx';

import { useAppEnv } from 'app/env';
import { AddressTab } from 'app/pages/Receive/AddressTab';
import { useAccount } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
export interface ReceiveProps {}

export const Receive: React.FC<ReceiveProps> = () => {
  const account = useAccount();
  const address = account.publicKey;

  const { fullPage, sidePanel } = useAppEnv();

  // Match SendManager's container sizing - use h-full to inherit from parent (body has safe area padding).
  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg relative')}>
      <AddressTab address={address} />
    </div>
  );
};
