import React, { FC } from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';
import { EarnSummaryPanel, ProviderLogo } from 'screens/earn-flow/components';
import { EARN_DATA } from 'screens/earn-flow/data';
import { EarnPosition, EarnVault } from 'screens/earn-flow/types';

const Earn: FC = () => {
  const { summary, positions, vaults } = EARN_DATA;
  const handleSeeAllClick = () => {
    hapticLight();
    navigate('/earn/positions');
  };

  return (
    <div className="h-full overflow-hidden bg-app-bg font-inter" data-testid="earn-page">
      <div className="h-full overflow-y-auto">
        <div className="flex flex-col px-4 pt-4 pb-32">
          <EarnSummaryPanel summary={summary} titleId="earn-summary-title" />

          <section className="mt-4" aria-labelledby="earn-positions-title">
            <div className="flex items-center justify-between">
              <h2 id="earn-positions-title" className="text-xl font-heading font-bold leading-none text-heading-gray">
                Current Positions
              </h2>
              <button
                type="button"
                onClick={handleSeeAllClick}
                className="text-xs font-heading font-bold leading-none text-heading-gray"
              >
                See All
              </button>
            </div>

            <div
              className="-mx-4 mt-5 overflow-x-auto no-scrollbar touch-pan-x"
              onPointerDown={event => event.stopPropagation()}
            >
              <div className="flex gap-5 px-4 pb-1">
                {positions.map(position => (
                  <PositionCard key={position.id} position={position} />
                ))}
              </div>
            </div>
          </section>

          <section className="mt-3" aria-labelledby="earn-vaults-title">
            <h2 id="earn-vaults-title" className="text-xl font-heading font-bold leading-none text-heading-gray">
              Featured Vaults
            </h2>

            <div className="mt-1 flex flex-col divide-y divide-rule-default">
              {vaults.map(vault => (
                <VaultRow key={vault.id} vault={vault} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

const PositionCard: FC<{ position: EarnPosition }> = ({ position }) => (
  <button
    type="button"
    onClick={() => {
      hapticLight();
      navigate(`/earn/positions/${position.id}`);
    }}
    className={classNames('shrink-0 rounded-2xl border border-[#EFEFF2] bg-white px-4 py-4 text-left')}
  >
    <div className="flex items-center gap-10">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderLogo protocol={position.protocol} className="h-4 w-4" />
        <div className="text-base font-bold leading-none text-pure-black">
          {position.protocol} &bull; {position.asset}
        </div>
      </div>
      <div className="rounded-full bg-green-100 px-2 py-1 text-xs font-bold font-heading leading-none text-green-500">
        {position.apy} APY
      </div>
    </div>

    <div className="mt-3 text-[22px] font-bold font-heading leading-none text-pure-black">{position.amount}</div>
    <div className="mt-2 text-xs font-bold leading-none text-green-500">
      {position.rewards} &bull; {position.age}
    </div>
  </button>
);

const VaultRow: FC<{ vault: EarnVault }> = ({ vault }) => (
  <button
    type="button"
    onClick={() => {
      hapticLight();
      navigate(`/earn/vaults/${vault.id}`);
    }}
    className="flex w-full items-center gap-3 py-4 text-left"
  >
    <span className="flex h-9.5 w-9.5 shrink-0 items-center justify-center rounded-[14px] bg-[#F0F0FF]">
      <ProviderLogo protocol={vault.protocol} className="h-8 w-8" />
    </span>

    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-base font-bold leading-tight text-pure-black">{vault.protocol}</span>
        <span className="truncate text-xs font-regular leading-tight text-text-secondary-token">
          {vault.asset} on {vault.network}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1 text-xs font-bold leading-tight">
        <span className="text-text-secondary-token">APY</span>
        <span className="text-status-positive">{vault.apy}</span>
      </div>
    </div>

    <Icon name={IconName.ChevronRightLucide} className="h-5 w-5 shrink-0 text-text-secondary-token" fill="none" />
  </button>
);

export default Earn;
