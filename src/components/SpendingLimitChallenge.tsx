import React, { useCallback, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { IConsumedAssetTotal } from 'lib/miden/db/types';
import {
  createSpendingLimitAuthorization,
  createUnpricedSpendingLimitAuthorization
} from 'lib/miden/spending-limits/authorization';
import { SpendingLimitAssessment, SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { StrictActionAuthentication } from './StrictActionAuthentication';

/** Dollars carry two decimal places on screen and six in storage, matching SpendingLimits.tsx. */
const USD_STORAGE_DECIMALS = 6;
const USD_DISPLAY_DECIMALS = 2;

/**
 * Format micro-dollars as an exact two-decimal display string.
 *
 * Deliberately NOT delegated to `lib/i18n/numbers`, for the same reason `formatUsdLimitInput` in
 * `SpendingLimits.tsx` isn't: that module's automatic mock rounds through `parseFloat`, so a
 * figure shown right before an authentication step would be tested against a lossy stand-in
 * rather than the real value.
 */
export function formatUsdMicroAmount(value: bigint): string {
  if (value < 0n) throw new RangeError('Invalid USD amount');
  const digits = value.toString().padStart(USD_STORAGE_DECIMALS + 1, '0');
  const integerPart = digits.slice(0, -USD_STORAGE_DECIMALS);
  const fraction = digits.slice(-USD_STORAGE_DECIMALS, -USD_STORAGE_DECIMALS + USD_DISPLAY_DECIMALS);
  return `$${integerPart}.${fraction}`;
}

export interface SpendingLimitChallengeProps {
  assessment?: SpendingLimitAssessment;
  unpriced?: { accountId: string; spends: IConsumedAssetTotal[]; revision: string };
  onResult: (authorization: SpendingLimitAuthorization | undefined) => void;
  now?: () => number;
  makeId?: () => string;
}

export const SpendingLimitChallenge: React.FC<SpendingLimitChallengeProps> = ({
  assessment,
  unpriced,
  onResult,
  now = () => Math.floor(Date.now() / 1000),
  makeId
}) => {
  const { t, i18n } = useTranslation();
  const breach = assessment?.breach;
  const resetTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language.replace('_', '-'), {
        // eslint-disable-next-line i18next/no-literal-string
        dateStyle: 'medium',
        // eslint-disable-next-line i18next/no-literal-string
        timeStyle: 'short'
      }),
    [i18n.language]
  );
  const handleAuthentication = useCallback(
    (result: 'authenticated' | 'cancelled') => {
      if (result === 'cancelled') {
        onResult(undefined);
        return;
      }
      if (assessment !== undefined) {
        onResult(createSpendingLimitAuthorization(assessment, now(), makeId));
      } else if (unpriced !== undefined) {
        onResult(
          createUnpricedSpendingLimitAuthorization(
            unpriced.accountId,
            unpriced.spends,
            unpriced.revision,
            now(),
            makeId
          )
        );
      }
    },
    [assessment, unpriced, makeId, now, onResult]
  );

  return (
    <Drawer open onOpenChange={open => !open && onResult(undefined)} screenKey="spending-limit-challenge">
      <DrawerContent data-testid="spending-limit-challenge">
        <DrawerHeader>
          <DrawerTitle>{t('spendingLimitChallengeTitle')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-4 pb-4 no-scrollbar">
          {breach !== undefined && assessment !== undefined ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-surface-secondary-token p-3 text-sm">
              <dt className="text-text-secondary-token">{t('amount')}</dt>
              <dd className="text-right font-medium text-heading-gray">{formatUsdMicroAmount(assessment.usdAmount)}</dd>
              <dt className="text-text-secondary-token">{t('spendingLimitCap')}</dt>
              <dd className="text-right text-heading-gray">{formatUsdMicroAmount(breach.limit)}</dd>
              <dt className="text-text-secondary-token">{t('spendingLimitOverBy')}</dt>
              <dd className="text-right text-status-negative">{formatUsdMicroAmount(breach.overBy)}</dd>
              <dt className="text-text-secondary-token">{t('spendingLimitResets')}</dt>
              <dd className="text-right text-heading-gray">
                {breach.resetAt === null
                  ? t('spendingLimitNoAutomaticReset')
                  : resetTimeFormatter.format(new Date(breach.resetAt * 1000))}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-heading-gray">{t('spendingLimitPriceUnavailable')}</p>
          )}
          <p className="text-sm text-text-secondary-token">{t('spendingLimitChangeInSettings')}</p>
          <StrictActionAuthentication
            reason={t('spendingLimitTransactionAuthenticationReason')}
            onResult={handleAuthentication}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default SpendingLimitChallenge;
