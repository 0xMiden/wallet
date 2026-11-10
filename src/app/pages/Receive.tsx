import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody, HomeGroupPaneRoot } from 'app/layouts/HomeGroupPane';
import { AddressTab } from 'app/pages/Receive/AddressTab';
import { SegmentedControl, SegmentedControlItem } from 'components/ui/SegmentedControl';
import { Spinner } from 'components/ui/Spinner';
import { useAccount } from 'lib/miden/front';
import { useNearIntentsConfig } from 'lib/one-click/config';
import { beginFlow, FlowHandle } from 'lib/telemetry';
import { useRouteDwell } from 'lib/telemetry/use-route-dwell';
import { navigate, useLocation } from 'lib/woozie';

// Loaded only when the user opens the tab: the form reads the 1Click catalog and the faucets.
const NearIntentsTab = React.lazy(() => import('screens/near-intents-flow/NearIntentsTab'));

export interface ReceiveProps {}

type ReceiveTab = 'miden' | 'near-intents';

/**
 * Receive surface - shows the account address (QR + copy/share). Pending
 * (claimable) notes live in the Activity tab's Pending filter
 * (`ACTIVITY_PENDING_PATH`). When the network offers NEAR Intents, a second
 * tab gives a 1Click deposit address for a token on another chain.
 */
const ReceiveManager: React.FC<ReceiveProps> = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const { pathname } = useLocation();
  const address = account.publicKey;
  const nearIntentsConfig = useNearIntentsConfig();
  const [tab, setTab] = useState<ReceiveTab>('miden');
  // With no NEAR Intents config there is one tab, and the page is the address alone.
  const activeTab: ReceiveTab = nearIntentsConfig ? tab : 'miden';

  /**
   * `receive_share` is a view flow, and this surface's purpose is to put a
   * usable address in front of the user — so it completes once the address is
   * there to show, and is cancelled if the user leaves before it ever arrives.
   *
   * Deliberately NOT gated on a copy or share tap: holding the QR up to be
   * scanned is an ordinary, successful receive that fires no such event, so
   * gating on one would report the most common success as abandonment.
   *
   * Held in a ref rather than state because settling must never re-render.
   */
  const flowRef = useRef<FlowHandle | null>(null);
  // Gated on the route, not on mount. TabLayout's home carousel mounts this page
  // on every app open, so a mount-triggered flow reported a completed
  // receive-address share every time the wallet was launched — the address
  // renders unconditionally, so it completed immediately too. Those were the
  // most numerous events the wallet emitted and none of them meant anything.
  //
  // Dwelled on rather than merely current. This pane sits between Send and Earn,
  // so it is the one the carousel transits most, and its flow completes on sight
  // of the address — meaning a swipe past it produced a `completed` share that
  // no duration filter on `result` could tell from a real one.
  const onReceiveRoute = useRouteDwell(pathname === '/receive' || pathname.startsWith('/receive/'));
  useEffect(() => {
    if (!onReceiveRoute) return;
    flowRef.current = beginFlow('receive_share');
    return () => {
      flowRef.current?.cancel();
      flowRef.current = null;
    };
  }, [onReceiveRoute]);

  // Clearing the ref makes this fire once and keeps the unmount above from
  // re-reporting a surface that already did its job.
  //
  // Depends on the route gate as well as the address. The address is resolved
  // before this page is ever reachable and then never changes, so keyed on
  // `address` alone this would run once at mount — while the gate was still
  // false and there was no flow — and never again. Every share would then be
  // reported cancelled, the previous bug exactly inverted.
  //
  // Depends on the tab too. The Miden address is on screen only on the Miden
  // tab, so the flow completes only there: a visit that stays on the NEAR
  // Intents tab never shows the address, and leaving it cancels the flow.
  useEffect(() => {
    if (!onReceiveRoute || !address || activeTab !== 'miden') return;
    const flow = flowRef.current;
    if (!flow) return;
    flowRef.current = null;
    flow.complete();
  }, [address, onReceiveRoute, activeTab]);

  const openBridgeDeposit = useCallback(() => {
    navigate('/bridge/deposit');
  }, []);

  const tabItems: readonly SegmentedControlItem<ReceiveTab>[] = [
    { id: 'miden', label: t('miden'), 'data-testid': 'receive-tab-miden' },
    {
      id: 'near-intents',
      label: t('nearIntentsTab'),
      badge: t('nearIntentsBeta'),
      ring: 'rainbow',
      'data-testid': 'receive-tab-near-intents'
    }
  ];
  const tabs = nearIntentsConfig ? (
    <SegmentedControl
      items={tabItems}
      value={activeTab}
      onChange={setTab}
      accent="receive"
      layout="fill"
      size="md"
      aria-label={t('receiveMethod')}
      data-testid="receive-tabs"
    />
  ) : undefined;

  return (
    // The shared home-group pane box, the same one Send, Earn and Swap are drawn in.
    <HomeGroupPaneRoot testId="receive-flow">
      {nearIntentsConfig && activeTab === 'near-intents' ? (
        <Suspense
          fallback={
            <HomeGroupPaneBody top="visual">
              {tabs}
              <div className="flex justify-center pt-10">
                <Spinner />
              </div>
            </HomeGroupPaneBody>
          }
        >
          <NearIntentsTab config={nearIntentsConfig} tabs={tabs} />
        </Suspense>
      ) : (
        <AddressTab address={address} onBridgeDeposit={openBridgeDeposit} tabs={tabs} />
      )}
    </HomeGroupPaneRoot>
  );
};

export { ReceiveManager as Receive };
