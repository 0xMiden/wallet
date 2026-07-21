import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';

import { TransactionSuccessLayout, TransactionSuccessProps } from './TransactionSuccessLayout';

/**
 * STUB — "You're Earning!" success view.
 *
 * Structure only: wires the shared layout with the earn title and the
 * "View Details" + Done (side-by-side `row`) footer so the shell's row layout
 * is exercised. It deliberately renders no body yet because the earn data model
 * does not exist.
 *
 * To finish (NOT built — needs a data model first):
 *   - Add an `earn` value to `ITransactionType` and an `IEarnExtraInputs`
 *     interface (protocol, market/token, principal, APY, est. earnings,
 *     solver + gas fee breakdown) in `lib/miden/db/types.ts`, plus a producer.
 *   - Route to it from the `TransactionSuccess` dispatcher on that discriminator.
 *   - Body: protocol summary pill (`$750 -> Aave · USDC · 5.24% APY`), a
 *     "…now earning…" description, and Position / Est. 1-year earnings /
 *     Total paid / Transaction rows. NOTE: earn rows need a secondary caption
 *     and a colored value, so `ReceiptRow` must be extended before use.
 *   - Wire the "View Details" action to the position-details route.
 *
 * Do NOT fabricate APY / earnings / fee values from the current `ITransaction`.
 */
export const EarnSuccess: FC<TransactionSuccessProps> = ({ onDoneClick }) => {
  const { t } = useTranslation();

  return (
    <TransactionSuccessLayout
      headerTitle={t('success', { defaultValue: 'Success!' })}
      title={t('youreEarning', { defaultValue: "You're Earning!" })}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewDetails', { defaultValue: 'View Details' }),
        // TODO: navigate to the position-details screen once the earn flow is wired.
        onClick: onDoneClick,
        variant: ButtonVariant.Secondary
      }}
      onClose={onDoneClick}
    />
  );
};
