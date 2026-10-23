import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/ui/Button';
import { Card } from 'components/ui/Card';

export const ArcadeCoinsCard: React.FC<{ balance: string | null; networkName: string; busy?: boolean }> = ({
  balance,
  networkName,
  busy = false
}) => {
  const { t } = useTranslation();
  return (
    <Card surface="outline" className="flex flex-col gap-3" aria-busy={busy} data-testid="arcade-allowance">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-label text-muted">{t('arcadeGameCoins')}</h2>
          <p className="text-title-section text-ink" aria-live="polite">
            {balance === null ? t('arcadeBalanceUnknown') : t('arcadeBalance', { balance })}
          </p>
        </div>
        <span className="text-caption text-muted text-right">{networkName}</span>
      </div>
      <p className="text-body-sm text-muted">{t('arcadeGcPurchasePackage')}</p>
      <Button disabled title={t('arcadeBuyMoreGc')} aria-describedby="gc-purchase-availability" />
      <p id="gc-purchase-availability" className="text-body-sm text-muted" role="status">
        {t('arcadeGcPurchaseUnavailable')}
      </p>
    </Card>
  );
};
