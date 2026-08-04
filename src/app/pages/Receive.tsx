import React, { useCallback, useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { AddressTab } from 'app/pages/Receive/AddressTab';
import { CrossChainTab } from 'app/pages/Receive/CrossChainTab';
import { DepositBridgeDrawer } from 'app/templates/DepositBridge';
import { TabPicker } from 'components/TabPicker';
import { isDepositTokenId, type DepositTokenId } from 'lib/deposit-bridge';
import { isBridgeDepositEnabled, isDepositAddressBridgeEnabled } from 'lib/feature-flags';
import { useAccount } from 'lib/miden/front';
import { hapticSelection } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { navigate, useLocation } from 'lib/woozie';

export interface ReceiveProps {}

type ReceiveTab = 'miden' | 'crosschain';

interface BridgeRequest {
  token?: DepositTokenId;
}

/** Parses `?tab=crosschain&bridge=1&token=ETH` off the Woozie search string. */
function parseReceiveIntent(search: string): { tab: ReceiveTab; bridge: boolean; token?: DepositTokenId } {
  const params = new URLSearchParams(search);
  const token = params.get('token');
  return {
    tab: params.get('tab') === 'crosschain' ? 'crosschain' : 'miden',
    bridge: params.get('bridge') === '1',
    token: token !== null && isDepositTokenId(token) ? token : undefined
  };
}

/**
 * Receive surface — shows the account address (QR + copy/share), plus a
 * Cross-chain tab with the vault-derived EVM deposit address when the deposit
 * bridge is enabled. Pending (claimable) notes live on their own
 * `/pending-notes` screen, reached from the Activity header.
 */
const ReceiveManager: React.FC<ReceiveProps> = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const account = useAccount();
  const address = account.publicKey;
  const evmAddress = account.evmAddress;

  const showCrossChain = isDepositAddressBridgeEnabled() && Boolean(evmAddress);

  const intent = useMemo(() => parseReceiveIntent(search), [search]);

  const [tab, setTab] = useState<ReceiveTab>(() => (showCrossChain ? intent.tab : 'miden'));
  const [bridgeRequest, setBridgeRequest] = useState<BridgeRequest | null>(null);

  useEffect(() => {
    if (!showCrossChain) return;
    setTab(intent.tab);
    if (intent.bridge) setBridgeRequest({ token: intent.token });
  }, [intent, showCrossChain]);

  const openBridgeDeposit = useCallback(() => {
    navigate('/bridge/deposit');
  }, []);

  const handleBridge = useCallback((token?: DepositTokenId) => {
    setBridgeRequest({ token });
  }, []);

  const handleTabChange = useCallback((index: number) => {
    hapticSelection();
    setTab(index === 1 ? 'crosschain' : 'miden');
  }, []);

  // Hardware/swipe back closes the bridge sheet before the page-level default runs.
  useMobileBackHandler(() => {
    if (bridgeRequest !== null) {
      setBridgeRequest(null);
      return true;
    }
    return false;
  }, [bridgeRequest]);

  // Receive is a HomeSwipeContainer pane — another horizontal Framer Motion drag
  // surface. Let the tab picker take its own pointer sequence, then stop
  // pointerdown from bubbling into the page-level swipe.
  const [toggleContainer, setToggleContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!toggleContainer) return;
    const claimGesture = (event: PointerEvent) => event.stopPropagation();
    toggleContainer.addEventListener('pointerdown', claimGesture);
    return () => toggleContainer.removeEventListener('pointerdown', claimGesture);
  }, [toggleContainer]);

  return (
    <div
      className={classNames('h-full w-full mx-auto overflow-hidden flex flex-col bg-app-bg relative')}
      data-testid="receive-flow"
    >
      {showCrossChain && evmAddress ? (
        <>
          <div ref={setToggleContainer} className="px-6 pt-4">
            <TabPicker
              data-testid="receive-tab-picker"
              tabs={[
                { id: 'miden', title: t('miden'), active: tab === 'miden' },
                { id: 'crosschain', title: t('crossChain'), active: tab === 'crosschain' }
              ]}
              onTabChange={handleTabChange}
            />
          </div>
          {tab === 'crosschain' ? (
            <CrossChainTab
              evmAddress={evmAddress}
              midenAddress={address}
              onBridge={handleBridge}
              onBridgeDeposit={openBridgeDeposit}
            />
          ) : (
            <AddressTab address={address} />
          )}
        </>
      ) : (
        <AddressTab
          address={address}
          onCrossChain={!isExtension() && isBridgeDepositEnabled() ? openBridgeDeposit : undefined}
        />
      )}
      {showCrossChain && (
        <DepositBridgeDrawer
          open={bridgeRequest !== null}
          onOpenChange={open => {
            if (!open) setBridgeRequest(null);
          }}
          account={account}
          initialToken={bridgeRequest?.token}
        />
      )}
    </div>
  );
};

export { ReceiveManager as Receive };
