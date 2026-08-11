import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { guardianEndpointDisplayName } from 'app/hooks/useCurrentGuardianEndpoint';
import { ReactComponent as GuardianSwitchArt } from 'app/icons/guardian-switch-success.svg';
import { Icon, IconName } from 'app/icons/v2';
import { ButtonVariant } from 'components/Button';
import { ISwitchGuardianExtraInputs } from 'lib/miden/db/types';
import { navigate } from 'lib/woozie';

import { SuccessDivider, TransactionSuccessLayout, TransactionSuccessProps } from './TransactionSuccessLayout';

const isSwitchGuardianExtraInputs = (value: unknown): value is ISwitchGuardianExtraInputs =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Partial<ISwitchGuardianExtraInputs>).newGuardianEndpoint === 'string';

/**
 * Success receipt for a completed switch-guardian transaction: robot + shield
 * hero, then a short "what changes now" primer instead of amount/receipt rows
 * (a rotation moves no funds). "View in Activities" sits above "Done" per the
 * design reference.
 */
export const GuardianSwitchSuccess: FC<TransactionSuccessProps> = ({ transaction, onDoneClick }) => {
  const { t } = useTranslation();

  // Identify the provider transition (issue #485): previous → new, resolved
  // from the transaction's recorded endpoints so it survives later rotations.
  const extra = isSwitchGuardianExtraInputs(transaction?.extraInputs) ? transaction?.extraInputs : undefined;
  const unknown = t('unknown');
  const previousName = extra?.previousGuardianEndpoint
    ? guardianEndpointDisplayName(extra.previousGuardianEndpoint, unknown)
    : undefined;
  const newName = extra ? guardianEndpointDisplayName(extra.newGuardianEndpoint, unknown) : undefined;

  const infoKeys = [
    'guardianSwitchSuccessInfo1',
    'guardianSwitchSuccessInfo2',
    'guardianSwitchSuccessInfo3',
    'guardianSwitchSuccessInfo4'
  ] as const;

  return (
    <TransactionSuccessLayout
      headerTitle=""
      hero={<GuardianSwitchArt className="h-40 w-auto" aria-hidden="true" />}
      title={t('guardianSwitchSuccessTitle')}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewInActivities'),
        onClick: () => navigate(transaction ? `/history-details/${transaction.id}` : '/history'),
        variant: ButtonVariant.Secondary
      }}
      secondaryFirst
      onClose={onDoneClick}
    >
      {newName && (
        <div className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-text-muted">
          {previousName && (
            <>
              <span>{previousName}</span>
              <Icon name={IconName.ArrowRight} size="xs" fill="currentColor" />
            </>
          )}
          <span>{newName}</span>
        </div>
      )}

      <SuccessDivider />

      <div className="mt-4 w-full text-left">
        <p className="text-base font-semibold text-heading-gray">{t('guardianSwitchSuccessInfoTitle')}</p>
        <ul className="mt-2 flex flex-col gap-2">
          {infoKeys.map(key => (
            <li key={key} className="flex gap-2 text-sm leading-5 text-heading-gray">
              <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-heading-gray" />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </div>
    </TransactionSuccessLayout>
  );
};
