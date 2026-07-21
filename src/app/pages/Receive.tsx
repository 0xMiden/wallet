import React, { useCallback } from 'react';

import classNames from 'clsx';

import BridgeDeposit from 'app/pages/BridgeDeposit';
import { AddressTab } from 'app/pages/Receive/AddressTab';
import { ReceiveStep } from 'app/pages/Receive/steps';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { useAccount } from 'lib/miden/front';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';

export interface ReceiveProps {}

const ROUTES: Route[] = [
  {
    name: ReceiveStep.Default,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    // The bridge flow is a single outer card so BridgeDeposit (and the state it
    // holds) mounts once. Its internal amount → route steps run on a nested
    // Navigator inside EvmBridgeDepositScreen.
    name: ReceiveStep.ShowBridgePage,
    animationIn: 'push',
    animationOut: 'pop'
  }
];

/**
 * Receive surface — shows the account address (QR + copy/share). Pending
 * (claimable) notes live on their own `/pending-notes` screen, reached from the
 * Activity header.
 */
const ReceiveManager: React.FC<ReceiveProps> = () => {
  const { navigateTo, goBack, cardStack } = useNavigator();
  const account = useAccount();
  const address = account.publicKey;

  useMobileBackHandler(() => {
    if (cardStack.length > 1) {
      goBack();
      return true;
    }
    return false;
  }, [cardStack.length, goBack]);

  const openBridgeDeposit = useCallback(() => {
    navigateTo(ReceiveStep.ShowBridgePage);
  }, [navigateTo]);

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case ReceiveStep.ShowBridgePage:
          return <BridgeDeposit onClose={goBack} />;
        case ReceiveStep.Default:
        default:
          return <AddressTab address={address} onBridgeDeposit={openBridgeDeposit} />;
      }
    },
    [address, goBack, openBridgeDeposit]
  );

  return (
    <div
      className={classNames('h-full w-full mx-auto overflow-hidden flex flex-col bg-app-bg relative')}
      data-testid="receive-flow"
    >
      <Navigator renderRoute={renderStep} />
    </div>
  );
};

const ReceiveNavigator: React.FC<ReceiveProps> = props => (
  <NavigatorProvider routes={ROUTES} initialRouteName={ReceiveStep.Default}>
    <ReceiveManager {...props} />
  </NavigatorProvider>
);

export { ReceiveNavigator as Receive };
