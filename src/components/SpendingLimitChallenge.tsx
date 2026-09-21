import React, { useCallback, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { formatBigInt } from 'lib/i18n/numbers';
import { createSpendingLimitAuthorization } from 'lib/miden/spending-limits/authorization';
import {
  SpendingLimitAssessment,
  SpendingLimitAssetSnapshot,
  SpendingLimitAuthorization
} from 'lib/miden/spending-limits/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { StrictActionAuthentication } from './StrictActionAuthentication';

export interface SpendingLimitChallengeProps {
  assessment: SpendingLimitAssessment;
  asset: SpendingLimitAssetSnapshot;
  onResult: (authorization: SpendingLimitAuthorization | undefined) => void;
  now?: () => number;
  makeId?: () => string;
}

export const SpendingLimitChallenge: React.FC<SpendingLimitChallengeProps> = ({
  assessment,
  asset,
  onResult,
  now = () => Math.floor(Date.now() / 1000),
  makeId
}) => {
  const { t, i18n } = useTranslation();
  const amount = useCallback((value: bigint) => `${formatBigInt(value, asset.decimals)} ${asset.symbol}`, [asset]);
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
      onResult(createSpendingLimitAuthorization(assessment, now(), makeId));
    },
    [assessment, makeId, now, onResult]
  );

  return (
    <Drawer open onOpenChange={open => !open && onResult(undefined)} screenKey="spending-limit-challenge">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('spendingLimitChallengeTitle')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-4 pb-4 no-scrollbar">
          <dl className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-secondary-token">{t('amount')}</dt>
              <dd className="font-medium text-ink">{amount(assessment.amount)}</dd>
            </div>
            {assessment.breaches.map(breach => (
              <div key={breach.period} className="rounded-xl bg-surface-secondary-token p-3">
                <h3 className="mb-2 font-medium text-ink">
                  {t(breach.period === '24h' ? 'spendingLimitPeriod24h' : 'spendingLimitPeriod7d')}
                </h3>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-text-secondary-token">{t('spendingLimitCap')}</dt>
                  <dd className="text-right text-ink">{amount(breach.limit)}</dd>
                  <dt className="text-text-secondary-token">{t('spendingLimitOverBy')}</dt>
                  <dd className="text-right text-status-negative">{amount(breach.overBy)}</dd>
                  <dt className="text-text-secondary-token">{t('spendingLimitResets')}</dt>
                  <dd className="text-right text-ink">
                    {breach.resetAt === null
                      ? t('spendingLimitNoAutomaticReset')
                      : resetTimeFormatter.format(new Date(breach.resetAt * 1000))}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
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
