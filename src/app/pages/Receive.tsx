import React from 'react';

import classNames from 'clsx';

import { AddressTab } from 'app/pages/Receive/AddressTab';
import { useAccount } from 'lib/miden/front';

export interface ReceiveProps {}

/**
 * Receive surface — shows the account address (QR + copy/share). Pending
 * (claimable) notes live on their own `/pending-notes` screen, reached from the
 * Activity header.
 */
const ReceiveManager: React.FC<ReceiveProps> = () => {
  const account = useAccount();
  const address = account.publicKey;

  return (
    <div
      className={classNames('h-full w-full mx-auto overflow-hidden flex flex-col bg-app-bg relative')}
      data-testid="receive-flow"
    >
      <AddressTab address={address} />
    </div>
  );
};

export { ReceiveManager as Receive };
