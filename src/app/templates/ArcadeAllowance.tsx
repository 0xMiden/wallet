import React, { useEffect, useSyncExternalStore } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { useWeeklyClaim } from 'lib/arcade/use-weekly-claim';
import { type ArcadeAccountScope, unavailableWeeklyClaimService } from 'lib/arcade/weekly-claim';
import { useAccount, useAllNetworks } from 'lib/miden/front/ready';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { subscribeBridgeConfig } from 'lib/remote-config/runtime';

import { ArcadeAllowanceCard } from './ArcadeAllowanceCard';

const AccountAllowance: React.FC<{ scope: ArcadeAccountScope; networkName: string }> = ({ scope, networkName }) => {
  const { snapshot, busy, claim, refresh } = useWeeklyClaim(scope, unavailableWeeklyClaimService);
  const active = usePageActive();
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  return (
    <ArcadeAllowanceCard
      snapshot={snapshot}
      busy={busy}
      networkName={networkName}
      onClaim={() => void claim()}
      onRefresh={() => void refresh()}
    />
  );
};

export const ArcadeAllowance: React.FC = () => {
  const account = useAccount();
  const networks = useAllNetworks();
  // This older stack's useNetwork predates effective-network reconciliation on main. Read the
  // same effective network as the catalog/chain here; never authorize against the legacy selection.
  const networkId = useSyncExternalStore(subscribeBridgeConfig, getEffectiveNetworkName);
  const networkName = networks.find(network => network.id === networkId)?.name ?? networkId;
  return (
    <AccountAllowance
      key={`${networkId}:${account.publicKey}`}
      scope={{ accountId: account.publicKey, networkId }}
      networkName={networkName}
    />
  );
};
