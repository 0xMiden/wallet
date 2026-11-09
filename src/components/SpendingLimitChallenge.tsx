import React, { useCallback, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { UsdAmount } from 'components/ui/TokenAmount';
import { formatAmountDisplay } from 'lib/i18n/amount-display';
import { IConsumedAssetTotal } from 'lib/miden/db/types';
import {
  createSpendingLimitAuthorization,
  createUnpricedSpendingLimitAuthorization
} from 'lib/miden/spending-limits/authorization';
import { SpendingLimitAssessment, SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { StrictActionAuthentication } from './StrictActionAuthentication';

/** Round micro-dollars up to cents before display. */
export function formatUsdMicroAmount(value: bigint): string {
  if (value < 0n) throw new RangeError('Invalid USD amount');
  return formatAmountDisplay(value, {
    decimals: 6,
    formatting: 'fixed',
    rounding: 'up',
    prefix: '$',
    trimTrailingZeros: false
  });
}

export interface SpendingLimitChallengeProps {
  /** `false` where the host's own back handler closes the challenge (the swap flow's). */
  closeOnBack?: boolean;
  assessment?: SpendingLimitAssessment;
  /** The exact spends `assessment` was computed from. Required together with `assessment`, since
   * the resulting `usd` authorization binds to them, not to the assessed dollar figure. */
  spends?: readonly IConsumedAssetTotal[];
  unpriced?: { accountId: string; spends: IConsumedAssetTotal[]; revision: string };
  onResult: (authorization: SpendingLimitAuthorization | undefined) => void;
  now?: () => number;
  makeId?: () => string;
}

export const SpendingLimitChallenge: React.FC<SpendingLimitChallengeProps> = ({
  assessment,
  spends,
  unpriced,
  onResult,
  now = () => Math.floor(Date.now() / 1000),
  makeId,
  closeOnBack
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
        onResult(createSpendingLimitAuthorization(assessment, spends ?? [], now(), makeId));
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
    [assessment, spends, unpriced, makeId, now, onResult]
  );

  return (
    <Drawer
      open
      onOpenChange={open => !open && onResult(undefined)}
      closeOnBack={closeOnBack}
      screenKey="spending-limit-challenge"
    >
      <DrawerContent data-testid="spending-limit-challenge">
        <DrawerHeader>
          <DrawerTitle>{t('spendingLimitChallengeTitle')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-4 pb-4 no-scrollbar">
          {breach !== undefined && assessment !== undefined ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-surface-secondary-token p-3 text-sm">
              <dt className="text-text-secondary-token">{t('amount')}</dt>
              <dd className="text-right font-medium text-ink">
                <UsdAmount
                  amount={assessment.usdAmount}
                  decimals={6}
                  formatting="fixed"
                  grouping={false}
                  rounding="up"
                />
              </dd>
              <dt className="text-text-secondary-token">{t('spendingLimitCap')}</dt>
              <dd className="text-right text-ink">
                <UsdAmount amount={breach.limit} decimals={6} formatting="fixed" grouping={false} rounding="up" />
              </dd>
              <dt className="text-text-secondary-token">{t('spendingLimitOverBy')}</dt>
              <dd className="text-right text-status-negative">
                <UsdAmount amount={breach.overBy} decimals={6} formatting="fixed" grouping={false} rounding="up" />
              </dd>
              <dt className="text-text-secondary-token">{t('spendingLimitResets')}</dt>
              <dd className="text-right text-ink">
                {breach.resetAt === null
                  ? t('spendingLimitNoAutomaticReset')
                  : resetTimeFormatter.format(new Date(breach.resetAt * 1000))}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted">{t('spendingLimitPriceUnavailable')}</p>
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
