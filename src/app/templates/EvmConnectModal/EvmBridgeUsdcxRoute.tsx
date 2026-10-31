import React from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button } from 'components/Button';
import { isFeatureBlocked } from 'components/FeatureUnavailable';
import { Notice } from 'components/ui/Notice';
import { SectionHeader } from 'components/ui/SectionHeader';
import { Skeleton } from 'components/ui/Skeleton';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { usdcxArrivalKey } from 'lib/usdcx/constant';
import { RouteCard } from 'screens/send-flow/Route';

/** The Epoch route for the same USDC, offered beside Circle where the chain's Epoch route takes it too. */
export interface EvmBridgeUsdcxFastOption {
  selected: boolean;
  onSelect: () => void;
  availability: FeatureAvailability;
  /** The quoted fee in US dollars; undefined while quoting or unpriced. */
  feeUsd?: number;
  loading: boolean;
  /** Shown under the Fast card while it is selected (a balance or quote notice). */
  notice?: string;
}

export interface EvmBridgeUsdcxRouteProps {
  confirmDisabled?: boolean;
  footerClassName?: string;
  notice?: string;
  fee?: string;
  sourceChainId: number;
  onConfirm: () => void;
  /** Circle and Epoch both carry the chain's USDC: the user picks the provider. */
  fast?: EvmBridgeUsdcxFastOption;
  onSelectCircle?: () => void;
}

export const EvmBridgeUsdcxRoute: React.FC<EvmBridgeUsdcxRouteProps> = ({
  confirmDisabled = false,
  notice,
  fee,
  sourceChainId,
  onConfirm,
  fast,
  onSelectCircle
}) => {
  const { t } = useTranslation();
  const circleSelected = !fast?.selected;
  // Built in plain JS so the em-dash fallback does not trip the no-literal-string i18n lint.
  const fastFeeText = fast?.feeUsd != null ? `$${toAdaptiveFixed(fast.feeUsd)}` : '—';
  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <Button
          title={t('continue')}
          accent="receive"
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <SectionHeader size="lg">{t('bridgeChooseRoute')}</SectionHeader>
      <p className="mb-4 text-body-sm text-muted">{t('bridgeRouteDescription')}</p>
      <div className="flex flex-col gap-4">
        <RouteCard
          emoji=""
          label={t('usdcxRouteName')}
          selected={circleSelected}
          onSelect={() => onSelectCircle?.()}
          fee={fee ?? t('noFee')}
          eta={t(usdcxArrivalKey(sourceChainId))}
          testId="bridge-route-usdcx"
          accent="receive"
          describedBy={circleSelected ? 'bridge-route-usdcx-notice' : undefined}
          description={
            circleSelected ? (
              <Notice variant="inline" id="bridge-route-usdcx-notice">
                {notice ?? t('usdcxRouteNotice')}
              </Notice>
            ) : undefined
          }
        />
        {fast && (
          <RouteCard
            emoji="⚡"
            label={t('bridgeRouteEpoch')}
            selected={fast.selected}
            onSelect={fast.onSelect}
            fee={
              fast.loading ? (
                <Skeleton className="h-4 w-12" />
              ) : (
                <span className="text-base font-bold text-ink">{fastFeeText}</span>
              )
            }
            eta={t('fastArrival')}
            disabled={isFeatureBlocked(fast.availability)}
            testId="bridge-route-fast"
            accent="receive"
            describedBy={fast.selected && fast.notice ? 'bridge-route-fast-notice' : undefined}
            description={
              fast.selected && fast.notice ? (
                <Notice variant="inline" id="bridge-route-fast-notice">
                  {fast.notice}
                </Notice>
              ) : undefined
            }
          />
        )}
      </div>
    </HomeGroupPaneBody>
  );
};
