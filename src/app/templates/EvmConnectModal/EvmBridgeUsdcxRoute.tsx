import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { RouteCard } from 'screens/send-flow/Route';

export interface EvmBridgeUsdcxRouteProps {
  /** Disable the confirm button, e.g. while a previous submit is signing. */
  confirmDisabled?: boolean;
  /** Padding classes for the confirm-button footer. Same default as the Fast/Slow route step. */
  footerClassName?: string;
  onConfirm: () => void;
}

/**
 * Route step for a USDC deposit. Circle xReserve is the only route that bridges
 * Sepolia USDC to USDCx on Miden, so the single card is always selected and the
 * step only confirms. Mirrors the layout of the Fast/Slow `Route` step.
 */
export const EvmBridgeUsdcxRoute: React.FC<EvmBridgeUsdcxRouteProps> = ({
  confirmDisabled = false,
  footerClassName = 'pt-4 pb-24',
  onConfirm
}) => {
  const { t } = useTranslation();

  return (
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        <span className="font-heading text-2xl leading-none font-bold text-[#808080]">{t('route')}</span>

        <div className="mt-6 flex flex-col gap-6">
          <RouteCard
            emoji="🔵"
            label={t('usdcxRouteName')}
            selected
            onSelect={() => undefined}
            fee={<span className="text-base font-bold text-ink">{t('noFee')}</span>}
            eta={t('usdcxArrival')}
            testId="bridge-route-usdcx"
            accent="brand"
          />
          <p className="text-xs text-ink/60">{t('usdcxRouteNotice')}</p>
        </div>
      </div>

      <div className={clsx('shrink-0', footerClassName)} data-navbar-cushion="true">
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      </div>
    </div>
  );
};
