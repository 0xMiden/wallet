import React, { useCallback, useEffect, useRef } from 'react';

import classNames from 'clsx';

import { AddressTab } from 'app/pages/Receive/AddressTab';
import { useAccount } from 'lib/miden/front';
import { beginFlow, FlowHandle } from 'lib/telemetry';
import { useRouteDwell } from 'lib/telemetry/use-route-dwell';
import { navigate, useLocation } from 'lib/woozie';

export interface ReceiveProps {}

/**
 * Receive surface — shows the account address (QR + copy/share). Pending
 * (claimable) notes live on their own `/pending-notes` screen, reached from the
 * Activity header.
 */
const ReceiveManager: React.FC<ReceiveProps> = () => {
  const account = useAccount();
  const { pathname } = useLocation();
  const address = account.publicKey;

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
  useEffect(() => {
    if (!onReceiveRoute || !address) return;
    const flow = flowRef.current;
    if (!flow) return;
    flowRef.current = null;
    flow.complete();
  }, [address, onReceiveRoute]);

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
