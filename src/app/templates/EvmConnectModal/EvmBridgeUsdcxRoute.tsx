import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button } from 'components/Button';
import { isFeatureBlocked } from 'components/FeatureUnavailable';
import { Notice } from 'components/ui/Notice';
import { SectionHeader } from 'components/ui/SectionHeader';
import { Skeleton } from 'components/ui/Skeleton';
import { formatUsdDisplay } from 'lib/i18n/amount-display';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { usdcxArrivalKey } from 'lib/usdcx/constant';
import { RouteCard, type RoutePayout, RouteSort, type RouteSortOrder } from 'screens/send-flow/Route';
import { rankBridgeRoutes } from 'screens/send-flow/route-ranking';

/** The Epoch route for the same USDC, offered beside Circle where the chain's Epoch route takes it too. */
export interface EvmBridgeUsdcxFastOption {
  selected: boolean;
  onSelect: () => void;
  availability: FeatureAvailability;
  /** The quoted fee in US dollars; undefined while quoting or unpriced. */
  feeUsd?: number;
  payout?: RoutePayout;
  loading: boolean;
  /** Shown under the Fast card while it is selected (a balance or quote notice). */
  notice?: string;
}

export interface EvmBridgeUsdcxRouteProps {
  confirmDisabled?: boolean;
  footerClassName?: string;
  notice?: string;
  fee?: string;
  payout?: RoutePayout;
  availability?: FeatureAvailability;
  feePending?: boolean;
  feeUnavailable?: boolean;
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
  payout,
  availability,
  feePending,
  feeUnavailable,
  sourceChainId,
  onConfirm,
  fast,
  onSelectCircle
}) => {
  const { t } = useTranslation();
  const [sort, setSort] = useState<RouteSortOrder>('best-value');
  const circleSelected = !fast?.selected;
  const circleDisabled = availability !== undefined && isFeatureBlocked(availability);
  const circleArrival = usdcxArrivalKey(sourceChainId);
  const sameAsset = payout && fast?.payout && sameWalletAccountId(payout.assetId, fast.payout.assetId);
  // Built in plain JS so the em-dash fallback does not trip the no-literal-string i18n lint.
  const fastFeeText = fast?.feeUsd != null ? formatUsdDisplay(fast.feeUsd) : '—';
  const routes = [
    {
      id: 'circle',
      disabled: circleDisabled,
      etaSeconds: circleArrival === 'usdcxArrivalArc' ? 60 : 120,
      receivedValue: sameAsset ? payout.amount : undefined,
      card: (
        <RouteCard
          emoji=""
          label={t('usdcxRouteName')}
          selected={circleSelected}
          onSelect={() => onSelectCircle?.()}
          fee={feePending ? <Skeleton className="h-4 w-12" /> : (fee ?? t(feeUnavailable ? 'unavailable' : 'noFee'))}
          payout={circleDisabled ? undefined : payout}
          eta={t(circleArrival)}
          testId="bridge-route-usdcx"
          accent="receive"
          disabled={circleDisabled}
          loading={feePending}
          describedBy={circleSelected ? 'bridge-route-usdcx-notice' : undefined}
          description={
            circleSelected ? (
              <Notice variant="inline" id="bridge-route-usdcx-notice">
                {notice ?? t('usdcxRouteNotice')}
              </Notice>
            ) : undefined
          }
        />
      )
    }
  ];
  if (fast) {
    const disabled = isFeatureBlocked(fast.availability);
    routes.push({
      id: 'epoch',
      disabled,
      etaSeconds: 30,
      receivedValue: sameAsset ? fast.payout?.amount : undefined,
      card: (
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
          payout={disabled ? undefined : fast.payout}
          eta={t('fastArrival')}
          disabled={disabled}
          loading={fast.loading}
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
      )
    });
  }
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
        {fast && <RouteSort value={sort} onChange={setSort} accent="receive" />}
        {rankBridgeRoutes(routes, sort).map(({ id, card }) => (
          <React.Fragment key={id}>{card}</React.Fragment>
        ))}
      </div>
    </HomeGroupPaneBody>
  );
};
