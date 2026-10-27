import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/ui/Button';
import { Card } from 'components/ui/Card';

/** What the Buy more GC entry can do: no sale on this network or none that fits, a quote in flight, or a live one. */
export type GcPurchaseEntryState = 'unavailable' | 'checking' | 'ready';

export const ArcadeCoinsCard: React.FC<{
  balance: string | null;
  networkName: string;
  busy?: boolean;
  purchase?: { state: GcPurchaseEntryState; onBuy: () => void };
}> = ({ balance, networkName, busy = false, purchase = { state: 'unavailable', onBuy: () => {} } }) => {
  const { t } = useTranslation();
  const purchaseStatus = (() => {
    switch (purchase.state) {
      case 'ready':
        return t('arcadeGcPurchaseReady');
      case 'checking':
        return t('arcadeGcPurchaseChecking');
      case 'unavailable':
        return t('arcadeGcPurchaseUnavailable');
    }
  })();
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
      <Button
        disabled={purchase.state !== 'ready'}
        isLoading={purchase.state === 'checking'}
        title={t('arcadeBuyMoreGc')}
        aria-describedby="gc-purchase-availability"
        onClick={purchase.onBuy}
        data-testid="arcade-buy-gc"
      />
      <p id="gc-purchase-availability" className="text-body-sm text-muted" role="status">
        {purchaseStatus}
      </p>
    </Card>
  );
};
