import React from 'react';

import { useTranslation } from 'react-i18next';
import { formatUnits } from 'viem';

import { DetailRow } from 'components/ui/DetailCard';
import { minimumUsdcxPayout, USDCX_DECIMALS, USDCX_DESTINATIONS } from 'lib/usdcx/constant';

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
  const allowance = USDCX_DESTINATIONS.get(chainId)?.payoutFeeAllowance;
  if (allowance === undefined) return null;
  const payout = minimumUsdcxPayout(chainId, amount);

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
