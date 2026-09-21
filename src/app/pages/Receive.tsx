import React, { useCallback } from 'react';

import { HomeGroupPaneRoot } from 'app/layouts/HomeGroupPane';
import { AddressTab } from 'app/pages/Receive/AddressTab';
import { useAccount } from 'lib/miden/front';
import { navigate } from 'lib/woozie';

export interface ReceiveProps {}

/**
 * Receive surface — shows the account address (QR + copy/share). Pending
 * (claimable) notes live on their own `/pending-notes` screen, reached from the
 * Activity header.
 */
const ReceiveManager: React.FC<ReceiveProps> = () => {
  const account = useAccount();
  const address = account.publicKey;

  const openBridgeDeposit = useCallback(() => {
    navigate('/bridge/deposit');
  }, []);

  return (
    // The shared home-group pane box, the same one Send, Earn and Swap are drawn in.
    <HomeGroupPaneRoot testId="receive-flow">
      <AddressTab address={address} onBridgeDeposit={openBridgeDeposit} />
    </HomeGroupPaneRoot>
  );
};

export { ReceiveManager as Receive };
