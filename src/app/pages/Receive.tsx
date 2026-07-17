import React, { useCallback } from 'react';

import classNames from 'clsx';

import { AddressTab } from 'app/pages/Receive/AddressTab';
import { useAccount } from 'lib/miden/front';
import { navigate } from 'lib/woozie';

export interface ReceiveProps {}

/**
 * Receive surface — shows the account address (QR + copy/share). Pending
 * (claimable) notes live on their own `/pending` screen, reached from the
 * Activity header.
 */
const ReceiveManager: React.FC<ReceiveProps> = () => {
  const account = useAccount();
  const address = account.publicKey;

  const openBridgeDeposit = useCallback(() => {
    navigate('/bridge/deposit');
  }, []);

  return (
    <div
      className={classNames('h-full w-full mx-auto overflow-hidden flex flex-col bg-app-bg relative')}
      data-testid="receive-flow"
    >
      <AddressTab address={address} onBridgeDeposit={openBridgeDeposit} />
    </div>
  );
};

export { ReceiveManager as Receive };
