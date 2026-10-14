import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { Button, ButtonVariant } from 'components/Button';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';
import { FlowFooter } from 'components/flow/FlowFooter';
import { ChoiceCardGroup } from 'components/ui/ChoiceCard';
import { DetailCard } from 'components/ui/DetailCard';
import { Skeleton } from 'components/ui/Skeleton';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hapticLight } from 'lib/mobile/haptics';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { useWalletStore } from 'lib/store';

import { BridgeRoute } from './types';
import { UsdcxPayoutRows, UsdcxPayoutTarget } from './UsdcxPayoutRows';
import { AgglayerEligibility } from './useAgglayerEligibility';

export interface RouteStepProps {
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
  eta,
  testId,
  accent,
  disabled,
  loading,
  describedBy
}) => (
  <button
    type="button"
    data-testid={testId}
    onClick={onSelect}
    aria-pressed={selected}
    disabled={disabled}
    aria-busy={loading}
    aria-describedby={describedBy}
    className={clsx(
      'flex w-full items-center rounded-2xl border bg-fill px-4 py-6 transition-colors text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50',
      selected ? ACCENT_CLASSES[accent].border : 'border-hairline'
    )}
  >
    <div className={clsx('flex flex-1 text-[20px] font-bold', ACCENT_CLASSES[accent].ink)}>{label}</div>
    <span className="h-6 w-px shrink-0 bg-border-card" />
    <div className="flex flex-1 items-center justify-center text-ink font-bold">{fee}</div>
    <span className="h-6 w-px shrink-0 bg-border-card" />
    <div className="flex flex-1 items-center justify-end text-base font-medium text-muted">{eta}</div>
  </button>
);

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
const UsdcxRouteOption: React.FC<Pick<RouteOptionsProps, 'route' | 'onRouteChange' | 'usdcxPayout'>> = ({
  route,
  onRouteChange,
  usdcxPayout
}) => {
  const { t } = useTranslation();
  const nativeFaucetId = useNativeFeeFaucetId();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeSymbol = resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId).symbol;

  return (
    <div className="mt-6 flex flex-col gap-4">
      <ChoiceCardGroup
        items={[
          {
            id: 'usdcx',
            title: t('usdcxRouteLabel'),
            subtitle: t('usdcxMidenFees', { symbol: nativeSymbol }),
            'data-testid': 'bridge-route-usdcx'
          }
        ]}
        value={route === 'usdcx' ? 'usdcx' : null}
        onChange={() => onRouteChange('usdcx')}
        aria-label={t('route')}
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
    hapticLight();
    onRouteChange(next);
  };

  if (usdcxAvailable) {
    return <UsdcxRouteOption route={route} onRouteChange={onRouteChange} usdcxPayout={usdcxPayout} />;
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
    <div className="mt-6 flex flex-col gap-6">
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
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        <span className="font-heading text-2xl leading-none font-bold text-muted">{t('route')}</span>

        <RouteOptions
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
      </div>

      <FlowFooter className="pt-4">
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      </FlowFooter>
    </div>
  );
};
