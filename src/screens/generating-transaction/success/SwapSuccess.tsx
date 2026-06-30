import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';

import { TransactionSuccessLayout, TransactionSuccessProps } from './TransactionSuccessLayout';

/**
 * STUB — "Swap Order Created!" success view.
 *
 * Structure only: wires the shared layout with the swap title and the
 * Done + "View in Activities" (stacked) footer so the shell's secondary-action
 * path is exercised. It deliberately renders no body yet because the swap data
 * model does not exist.
 *
 * To finish (NOT built — needs a data model first):
 *   - Add a `swap` value to `ITransactionType` and an `ISwapExtraInputs`
 *     interface (in/out faucetId + amounts, expiry block/time, cancel terms)
 *     in `lib/miden/db/types.ts`, plus a backend producer for it.
 *   - Route to it from the `TransactionSuccess` dispatcher on that discriminator.
 *   - Body: token-to-token summary pill (`375 MDN -> 0.193359 ETH`), a
 *     "We're sourcing liquidity…" description, and Expires / Cancel rows.
 *   - Wire the "View in Activities" action to the Activities route.
 *
 * Do NOT fabricate APY / expiry / cancel values from the current `ITransaction`.
 */
export const SwapSuccess: FC<TransactionSuccessProps> = ({ onDoneClick }) => {
  const { t } = useTranslation();

  return (
    <TransactionSuccessLayout
      headerTitle={t('success', { defaultValue: 'Success!' })}
      title={t('swapOrderCreated', { defaultValue: 'Swap Order Created!' })}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewInActivities', { defaultValue: 'View in Activities' }),
        // TODO: navigate to the Activities screen once the swap flow is wired.
        onClick: onDoneClick,
        variant: ButtonVariant.Secondary
      }}
      actionsLayout="stacked"
      onClose={onDoneClick}
    />
  );
};
