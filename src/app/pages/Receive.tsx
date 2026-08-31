import React, { useCallback, useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { AddressTab } from 'app/pages/Receive/AddressTab';
import { CrossChainTab } from 'app/pages/Receive/CrossChainTab';
import { TabPicker } from 'components/TabPicker';
import { isDepositTokenId, type DepositTokenId } from 'lib/deposit-bridge';
import { isBridgeDepositEnabled, isDepositAddressBridgeEnabled } from 'lib/feature-flags';
import { useAccount } from 'lib/miden/front';
import { hapticSelection } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { navigate, useLocation } from 'lib/woozie';

export interface ReceiveProps {}

type ReceiveTab = 'miden' | 'crosschain';

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

  // `?bridge=1` is a request to review a bridge for funds already on the
  // address — a full-screen page, so it is a navigation, not local state.
  useEffect(() => {
    if (!showCrossChain) return;
    setTab(intent.tab);
    if (intent.bridge && intent.token) navigate(`/deposit-bridge/review?token=${intent.token}`);
  }, [intent, showCrossChain]);

  const openBridgeDeposit = useCallback(() => {
    navigate('/bridge/deposit');
  }, []);

  const handleTabChange = useCallback((index: number) => {
    hapticSelection();
    setTab(index === 1 ? 'crosschain' : 'miden');
  }, []);

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
            <CrossChainTab evmAddress={evmAddress} midenAddress={address} />
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
    </div>
  );
};

export { ReceiveManager as Receive };
