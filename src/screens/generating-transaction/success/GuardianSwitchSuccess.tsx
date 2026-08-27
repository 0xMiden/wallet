import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { guardianEndpointDisplayName } from 'app/hooks/useCurrentGuardianEndpoint';
import { ReactComponent as GuardianSwitchArt } from 'app/icons/guardian-switch-success.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Alert, AlertVariant } from 'components/Alert';
import { ButtonVariant } from 'components/Button';
import { ISwitchGuardianExtraInputs } from 'lib/miden/db/types';
import { navigate } from 'lib/woozie';

import { SuccessDivider, TransactionSuccessLayout, TransactionSuccessProps } from './TransactionSuccessLayout';

const isSwitchGuardianExtraInputs = (value: unknown): value is ISwitchGuardianExtraInputs =>
  !!value &&
  typeof value === 'object' &&
  'newGuardianEndpoint' in value &&
  typeof value.newGuardianEndpoint === 'string';

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

  // A rotation can COMMIT on chain and still leave a post-commit step undone:
  // the completion handler records that in `endpointPersistFailed` (this device
  // never saved the new address, so it is still pointed at the old operator) and
  // `registerFailed` (the new operator holds no state for the account yet). Both
  // are deliberately Completed rather than Failed — the switch really did
  // happen — but rendering the same unconditional "you're protected" receipt
  // over either one tells the user the opposite of what the row says, on the
  // last screen they will ever look at for this operation. The unsaved-address
  // case needs them; the pending-registration case self-heals from the sync
  // loop, so it explains rather than instructs.
  const endpointNotSaved = extra?.endpointPersistFailed === true;
  const registrationPending = extra?.registerFailed === true;

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
      {/* A custom endpoint is shown as its raw host, which can be long enough to
          push the pair off screen; break it rather than overflow. */}
      {newName && (
        <div className="mt-2 flex min-w-0 items-center justify-center gap-1.5 text-sm font-semibold text-heading-gray">
          {previousName && (
            <>
              {/* The arrow is the only thing carrying direction, and an untitled
                  SVG is skipped — so the pair read as "OpenZeppelin Koda". The
                  labels the review screen shows visibly are read out here
                  instead, using the same keys. */}
              <span className="sr-only">{t('currentGuardianLabel')}: </span>
              <span className="break-all">{previousName}</span>
              <span className="shrink-0" aria-hidden="true">
                <Icon name={IconName.ArrowRight} size="xs" fill="currentColor" />
              </span>
            </>
          )}
          {/* Outside the previous-name branch: a legacy row has only the new
              endpoint, and with the label nested it announced a bare hostname
              with nothing saying what it was. */}
          <span className="sr-only">{t('newGuardianLabel')}: </span>
          <span className="break-all">{newName}</span>
        </div>
      )}

      {(endpointNotSaved || registrationPending) && (
        <Alert
          className="mt-3 w-full text-left"
          variant={AlertVariant.Warning}
          title={
            <>
              <span className="font-semibold">{t('guardianSwitchSetupIncompleteTitle')}</span>{' '}
              {t(endpointNotSaved ? 'guardianSwitchEndpointNotSavedBody' : 'guardianSwitchRegistrationPendingBody')}
            </>
          }
        />
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
