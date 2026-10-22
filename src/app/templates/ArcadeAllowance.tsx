import React, { useEffect, useMemo, useSyncExternalStore } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { useWeeklyClaim } from 'lib/arcade/use-weekly-claim';
import { type ArcadeAccountScope, type WeeklyClaimService } from 'lib/arcade/weekly-claim';
import { useMidenContext } from 'lib/miden/front/client';
import { useAccount, useAllNetworks } from 'lib/miden/front/ready';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { subscribeBridgeConfig } from 'lib/remote-config/runtime';

import { ArcadeAllowanceCard } from './ArcadeAllowanceCard';
import { GcClaimReviewDrawer } from './GcClaimReviewDrawer';

const AccountAllowance: React.FC<{ scope: ArcadeAccountScope; networkName: string }> = ({ scope, networkName }) => {
  const { readGcWeeklyClaim, prepareGcWeeklyClaim, submitGcWeeklyClaim } = useMidenContext();
  const service = useMemo<WeeklyClaimService>(
    () => ({
      read: readGcWeeklyClaim,
      prepare: prepareGcWeeklyClaim,
      submit: submitGcWeeklyClaim
    }),
    [readGcWeeklyClaim, prepareGcWeeklyClaim, submitGcWeeklyClaim]
  );
  const { snapshot, busy, review, error, claim, recover, refresh, confirmReview, cancelReview } = useWeeklyClaim(
    scope,
    service
  );
  const active = usePageActive();
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  return (
    <>
      <ArcadeAllowanceCard
        snapshot={snapshot}
        busy={busy}
        error={error}
        networkName={networkName}
        onClaim={() => void claim()}
        onRecover={operationId => void recover(operationId)}
        onRefresh={() => void refresh()}
      />
      <GcClaimReviewDrawer review={review} busy={busy} onConfirm={() => void confirmReview()} onCancel={cancelReview} />
    </>
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
