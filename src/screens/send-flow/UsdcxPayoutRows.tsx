import React from 'react';

import { useTranslation } from 'react-i18next';
import { formatUnits } from 'viem';

import { DetailRow } from 'components/ui/DetailCard';
import { minimumUsdcxPayout, USDCX_DECIMALS, usdcxDestinations } from 'lib/usdcx/constant';
import { EvmUsdValue } from 'screens/generating-transaction/EvmUsdValue';

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
  const allowance = usdcxDestinations().get(chainId)?.payoutFeeAllowance;
  if (allowance === undefined) return null;
  const address = usdcxDestinations().get(chainId)?.usdc;
  const payout = minimumUsdcxPayout(chainId, amount);

  return (
    <>
      <DetailRow
        label={t('usdcxCircleFee')}
        data-testid="usdcx-payout-fee"
        sub={<EvmUsdValue amount={allowance} decimals={USDCX_DECIMALS} chainId={chainId} address={address} />}
      >
        {t('usdcxPayoutFeeUpTo', { amount: formatUnits(allowance, USDCX_DECIMALS) })}
      </DetailRow>
      {payout > 0n && (
        <DetailRow
          label={t('youReceive')}
          data-testid="usdcx-payout-net"
          sub={<EvmUsdValue amount={payout} decimals={USDCX_DECIMALS} chainId={chainId} address={address} />}
        >
          {t('usdcxPayoutAtLeast', { amount: formatUnits(payout, USDCX_DECIMALS) })}
        </DetailRow>
      )}
    </>
  );
};
