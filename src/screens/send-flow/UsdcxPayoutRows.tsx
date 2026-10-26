import React from 'react';

import { useTranslation } from 'react-i18next';

import { DetailRow } from 'components/ui/DetailCard';
import { usdcxDestinations } from 'lib/usdcx/constant';

/** A USDCx burn's destination chain and its amount in USDCx base units. */
export interface UsdcxPayoutTarget {
  chainId: number;
  amount: bigint;
}

/**
 * Circle's fee on a USDCx burn's payout. No Circle API quotes the fee of one burn and it moves with network fees
 * (Circle took 2.5635 USDC from a Sepolia payout), so the row promises no bound on it or on what the recipient gets.
 */
export const UsdcxPayoutRows: React.FC<Pick<UsdcxPayoutTarget, 'chainId'>> = ({ chainId }) => {
  const { t } = useTranslation();
  if (!usdcxDestinations().has(chainId)) return null;

  return (
    <DetailRow label={t('usdcxCircleFee')} data-testid="usdcx-payout-fee">
      {t('usdcxPayoutFeeVaries')}
    </DetailRow>
  );
};
