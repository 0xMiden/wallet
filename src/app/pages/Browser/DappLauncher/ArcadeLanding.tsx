import React, { useEffect } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { useWeeklyClaim } from 'lib/arcade/use-weekly-claim';
import { type ArcadeAccountScope, unavailableWeeklyClaimService } from 'lib/arcade/weekly-claim';
import type { ExploreItem } from 'lib/dapp-browser/explore-catalog';
import { useAccount, useNetwork } from 'lib/miden/front/ready';

import { ArcadeAllowanceCard, ArcadeGameCatalog } from './ArcadeView';

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

export const ArcadeLanding: React.FC<{
  games: ExploreItem[];
  pending: boolean;
  onOpen: (url: string) => void;
}> = props => {
  const account = useAccount();
  const network = useNetwork();
  return (
    <div className="flex flex-col gap-6 px-4 pt-2">
      <AccountAllowance
        key={`${network.id}:${account.publicKey}`}
        scope={{ accountId: account.publicKey, networkId: network.id }}
        networkName={network.name}
      />
      <ArcadeGameCatalog {...props} />
    </div>
  );
};
