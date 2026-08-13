import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';
import { GuardianTransitionHero } from 'components/GuardianTransitionHero';
import { ISwitchGuardianExtraInputs } from 'lib/miden/db/types';
import { navigate } from 'lib/woozie';

import { TransactionSuccessLayout, TransactionSuccessProps } from './TransactionSuccessLayout';

/**
 * "Guardian Updated!" success view shown once a `switch-guardian` rotation
 * commits. Unlike the generic `SendSuccess` fallback it replaced, it names the
 * PREVIOUS → NEW Guardian provider and links to the resulting Activity record,
 * so the rotation ends with an explicit, dismissible confirmation (#485).
 *
 * The provider pair is read ONLY from the persisted `extraInputs` audit trail
 * (`ISwitchGuardianExtraInputs`), never from the live account endpoint — that
 * already resolves to the NEW provider post-switch, so it can't name where the
 * account came from. Legacy rows persisted before the audit trail carry no
 * `previousGuardianEndpoint`; `GuardianTransitionHero` renders its localized
 * "Unknown" fallback for the missing side rather than throwing.
 */
export const GuardianRotationSuccess: FC<TransactionSuccessProps> = ({ transaction, onDoneClick }) => {
  const { t } = useTranslation();

  const extra: ISwitchGuardianExtraInputs | undefined =
    transaction?.type === 'switch-guardian' ? transaction.extraInputs : undefined;

  return (
    <TransactionSuccessLayout
      headerTitle=""
      title={t('guardianRotationComplete')}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewActivity'),
        onClick: () => navigate(transaction ? `/history-details/${transaction.id}` : '/history'),
        variant: ButtonVariant.Secondary
      }}
      onClose={onDoneClick}
    >
      <GuardianTransitionHero
        previousEndpoint={extra?.previousGuardianEndpoint}
        newEndpoint={extra?.newGuardianEndpoint}
        previousLabel={t('from')}
        newLabel={t('to')}
        className="mt-6"
      />
    </TransactionSuccessLayout>
  );
};
