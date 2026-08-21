import React, { useCallback, useEffect, useRef } from 'react';

import classNames from 'clsx';

import { AddressTab } from 'app/pages/Receive/AddressTab';
import { useAccount } from 'lib/miden/front';
import { beginFlow, FlowHandle } from 'lib/telemetry';
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
  useEffect(() => {
    flowRef.current = beginFlow('receive_share');
    return () => {
      flowRef.current?.cancel();
      flowRef.current = null;
    };
  }, []);

  // Clearing the ref makes this fire once and keeps the unmount above from
  // re-reporting a surface that already did its job.
  useEffect(() => {
    if (!address) return;
    const flow = flowRef.current;
    if (!flow) return;
    flowRef.current = null;
    flow.complete();
  }, [address]);

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
