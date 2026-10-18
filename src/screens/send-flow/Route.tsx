import React from 'react';

import { useTranslation } from 'react-i18next';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button, ButtonVariant } from 'components/Button';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { FlowAccent } from 'components/flow/accent';
import { CardButton } from 'components/ui/Card';
import { DetailCard } from 'components/ui/DetailCard';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SelectionCheck } from 'components/ui/SelectionCheck';
import { Skeleton } from 'components/ui/Skeleton';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { useWalletStore } from 'lib/store';

import { BridgeRoute } from './types';
import { UsdcxPayoutRows, UsdcxPayoutTarget } from './UsdcxPayoutRows';
import { AgglayerEligibility } from './useAgglayerEligibility';

export interface RouteStepProps {
  accent?: FlowAccent;
  usdcxAvailable?: boolean;
  route: BridgeRoute;
  onRouteChange: (route: BridgeRoute) => void;
  /** Fast-route fee in USD (input value − quoted USDC out). undefined while quoting / unavailable. */
  fastFeeUsd?: number;
  fastQuoteLoading: boolean;
  /** Extra message rendered below the cards (e.g. a route-specific notice). */
  notice?: React.ReactNode;
  /** Disable the confirm button — e.g. the quote isn't ready, or an unsupported route+token combo. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  /** Each route's feature: an unavailable or still-loading route is greyed out and takes no tap. */
  fastAvailability: FeatureAvailability;
  slowAvailability: FeatureAvailability;
}

export interface RouteCardProps {
  emoji: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  fee: React.ReactNode;
  feeLabelKey?: string;
  eta: string;
  testId?: string;
  accent: FlowAccent;
  disabled?: boolean;
  loading?: boolean;
  /** Id of the notice that explains why the card is disabled. */
  describedBy?: string;
}

/** One selectable route row. Shared with the USDCx deposit route step. */
export const RouteCard: React.FC<RouteCardProps> = ({
  label,
  selected,
  onSelect,
  fee,
  feeLabelKey = 'bridgeRouteFee',
  eta,
  testId,
  accent,
  disabled,
  loading,
  describedBy
}) => (
  <CardButton
    surface="outline"
    padding="none"
    type="button"
    data-testid={testId}
    onClick={onSelect}
    aria-pressed={selected}
    disabled={disabled}
    aria-busy={loading}
    aria-describedby={describedBy}
    className="w-full disabled:opacity-50"
  >
    <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
      <span className="text-title-section text-ink">{label}</span>
      {selected && <SelectionCheck accent={accent} />}
    </div>
    <div className="grid grid-cols-2 gap-4 border-t border-hairline px-4 py-3">
      <RouteMetric labelKey={feeLabelKey}>{fee}</RouteMetric>
      <RouteMetric labelKey="bridgeArrivalEstimate">{eta}</RouteMetric>
    </div>
  </CardButton>
);

const RouteMetric: React.FC<{ labelKey: string; children: React.ReactNode }> = ({ labelKey, children }) => {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-caption text-muted">{t(labelKey)}</span>
      <span className="text-value text-ink">{children}</span>
    </span>
  );
};

export type RouteOptionsProps = Pick<
  RouteStepProps,
  | 'route'
  | 'onRouteChange'
  | 'fastFeeUsd'
  | 'fastQuoteLoading'
  | 'notice'
  | 'usdcxAvailable'
  | 'fastAvailability'
  | 'slowAvailability'
> & {
  accent?: FlowAccent;
  slowStatus: AgglayerEligibility;
  /** A USDCx burn's destination and amount, once the send has both: the card shows Circle's fee and the payout. */
  usdcxPayout?: UsdcxPayoutTarget;
};

/** The USDCx burn's one route card. Its fees are paid in the native asset, so the subtitle names that asset. */
const UsdcxRouteOption: React.FC<Pick<RouteOptionsProps, 'route' | 'onRouteChange' | 'usdcxPayout' | 'accent'>> = ({
  route,
  onRouteChange,
  usdcxPayout,
  accent = 'brand'
}) => {
  const { t } = useTranslation();
  const nativeFaucetId = useNativeFeeFaucetId();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeSymbol = resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId).symbol;

  return (
    <div className="mt-6 flex flex-col gap-4">
      <RouteCard
        emoji=""
        label={t('usdcxRouteLabel')}
        selected={route === 'usdcx'}
        onSelect={() => {
          if (route !== 'usdcx') {
            onRouteChange('usdcx');
          }
        }}
        fee={t('usdcxMidenFees', { symbol: nativeSymbol })}
        feeLabelKey="networkFee"
        eta={t('bridgePayoutTiming')}
        testId="bridge-route-usdcx"
        accent={accent}
      />
      {usdcxPayout && (
        <DetailCard>
          <UsdcxPayoutRows chainId={usdcxPayout.chainId} amount={usdcxPayout.amount} />
        </DetailCard>
      )}
      <p className="text-caption text-muted" data-testid="usdcx-burn-notice">
        {t('usdcxWithdrawalNotice')}
      </p>
    </div>
  );
};

// Each notice answers for its own route, so the card points at it by id (one RouteOptions per screen).
const FAST_NOTICE_ID = 'bridge-route-fast-unavailable';
const SLOW_NOTICE_ID = 'bridge-route-slow-unavailable';

/** The Fast / Slow route cards and their notice, shared by every route step's layout. */
export const RouteOptions: React.FC<RouteOptionsProps> = ({
  route,
  onRouteChange,
  fastFeeUsd,
  fastQuoteLoading,
  notice,
  usdcxAvailable,
  slowStatus,
  fastAvailability,
  slowAvailability,
  accent = 'brand',
  usdcxPayout
}) => {
  const { t } = useTranslation();
  const slowAllowed = slowStatus === 'allowed';
  let slowFee: React.ReactNode = <span className="text-base font-bold text-ink">{t('noFee')}</span>;
  let slowNotice: React.ReactNode;
  switch (slowStatus) {
    case 'loading':
      slowFee = <Skeleton className="h-4 w-12" />;
      slowNotice = t('agglayerCheckingToken');
      break;
    case 'unsupported':
      slowFee = t('unavailable');
      slowNotice = t('agglayerTokenUnsupported');
      break;
    case 'error':
      slowFee = t('unavailable');
      slowNotice = t('agglayerTokenCheckFailed');
      break;
  }

  const select = (next: BridgeRoute) => {
    if (next === route) return;
    onRouteChange(next);
  };

  if (usdcxAvailable) {
    return <UsdcxRouteOption route={route} onRouteChange={onRouteChange} usdcxPayout={usdcxPayout} accent={accent} />;
  }

  // Built in plain JS (not JSX) so the em-dash fallback doesn't trip the
  // no-literal-string i18n lint; "$1.84" is excluded as a $-prefixed value.
  const feeText = fastFeeUsd != null ? `$${toAdaptiveFixed(fastFeeUsd)}` : '—';
  const fastFee = fastQuoteLoading ? (
    <Skeleton className="h-4 w-12" />
  ) : (
    <span className="text-base font-bold text-ink">{feeText}</span>
  );

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <RouteCard
          emoji="⚡"
          label={t('fast')}
          selected={route === 'epoch'}
          onSelect={() => select('epoch')}
          fee={fastFee}
          eta={t('fastArrival')}
          disabled={isFeatureBlocked(fastAvailability)}
          describedBy={fastAvailability.state === 'unavailable' ? FAST_NOTICE_ID : undefined}
          testId="bridge-route-fast"
          accent={accent}
        />
        <FeatureUnavailableNotice
          availability={fastAvailability}
          variant="inline"
          id={FAST_NOTICE_ID}
          data-testid="feature-unavailable-notice-fast"
        />
      </div>
      <div className="flex flex-col gap-2">
        <RouteCard
          emoji="🕐"
          label={t('slow')}
          selected={route === 'agglayer' && slowAllowed}
          disabled={!slowAllowed || isFeatureBlocked(slowAvailability)}
          loading={slowStatus === 'loading'}
          describedBy={slowAvailability.state === 'unavailable' ? SLOW_NOTICE_ID : undefined}
          onSelect={() => select('agglayer')}
          fee={slowFee}
          eta={t('slowArrival')}
          testId="bridge-route-slow"
          accent={accent}
        />
        <FeatureUnavailableNotice
          availability={slowAvailability}
          variant="inline"
          id={SLOW_NOTICE_ID}
          data-testid="feature-unavailable-notice-slow"
        />
      </div>
      {slowNotice && (
        <p role="status" className="text-xs text-muted">
          {slowNotice}
        </p>
      )}
      {notice && <p className="text-xs text-muted">{notice}</p>}
    </div>
  );
};

/**
 * Cross-chain route picker, shown after the destination network is chosen for a
 * 0x recipient. Fast = Epoch (any token → USDC, settles in ~seconds, charges a
 * fee = input value − USDC received); Slow = Agglayer. The send flow's SendRoute
 * gates Slow on the bridge registry; an EVM deposit has no Miden faucet to check.
 */
export const Route: React.FC<RouteStepProps> = ({
  accent = 'brand',
  usdcxAvailable,
  route,
  onRouteChange,
  fastFeeUsd,
  fastQuoteLoading,
  notice,
  confirmDisabled,
  onConfirm,
  fastAvailability,
  slowAvailability
}) => {
  const { t } = useTranslation();

  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <Button
          title={t('continue')}
          variant={ButtonVariant.Primary}
          accent={accent}
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <SectionHeader size="lg">{t('bridgeChooseRoute')}</SectionHeader>
      <p className="text-body-sm text-muted">{t('bridgeRouteDescription')}</p>
      <RouteOptions
        accent={accent}
        usdcxAvailable={usdcxAvailable}
        route={route}
        onRouteChange={onRouteChange}
        fastFeeUsd={fastFeeUsd}
        fastQuoteLoading={fastQuoteLoading}
        notice={notice}
        slowStatus="allowed"
        fastAvailability={fastAvailability}
        slowAvailability={slowAvailability}
      />
    </HomeGroupPaneBody>
  );
};
