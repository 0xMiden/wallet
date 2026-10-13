import React from 'react';

import { useTranslation } from 'react-i18next';
import { formatUnits } from 'viem';

import { DetailRow } from 'components/ui/DetailCard';
import { USDCX_DECIMALS } from 'lib/usdcx/constant';
import { minimumPayout } from 'lib/usdcx/routes';
import { useUsdcxRoutes } from 'lib/usdcx/use-usdcx-routes';

/** A USDCx burn's destination chain and its amount in USDCx base units. */
export interface UsdcxPayoutTarget {
  chainId: number;
  amount: bigint;
}

/**
 * Circle's fee on a USDCx burn's payout and the least the recipient receives. No Circle API quotes the fee of one
 * burn, so both figures come from the destination's fee allowance. The payout row is left out while the allowance
 * takes the whole amount, which the amount step and the review refuse.
 */
export const UsdcxPayoutRows: React.FC<UsdcxPayoutTarget> = ({ chainId, amount }) => {
  const { t } = useTranslation();
  const routes = useUsdcxRoutes();
  const allowance = routes?.destinations.get(chainId)?.payoutFeeAllowance;
  if (!routes || allowance === undefined) return null;
  const payout = minimumPayout(routes.destinations, chainId, amount);

  return (
    <>
      <DetailRow label={t('usdcxCircleFee')} data-testid="usdcx-payout-fee">
        {t('usdcxPayoutFeeUpTo', { amount: formatUnits(allowance, USDCX_DECIMALS) })}
      </DetailRow>
      {payout > 0n && (
        <DetailRow label={t('youReceive')} data-testid="usdcx-payout-net">
          {t('usdcxPayoutAtLeast', { amount: formatUnits(payout, USDCX_DECIMALS) })}
        </DetailRow>
      )}
    </>
  );
};
