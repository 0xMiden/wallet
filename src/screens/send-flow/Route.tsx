import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';
import { FlowFooter } from 'components/flow/FlowFooter';
import { Skeleton } from 'components/ui/Skeleton';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import type { FeatureAvailability } from 'lib/remote-config/availability';

import { BridgeRoute } from './types';
import { AgglayerEligibility } from './useAgglayerEligibility';

export interface RouteStepProps {
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

interface RouteCardProps {
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
}

const RouteCard: React.FC<RouteCardProps> = ({
  label,
  selected,
  onSelect,
  fee,
  eta,
  testId,
  accent,
  disabled,
  loading
}) => (
  <button
    type="button"
    data-testid={testId}
    onClick={onSelect}
    aria-pressed={selected}
    disabled={disabled}
    aria-busy={loading}
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
  'route' | 'onRouteChange' | 'fastFeeUsd' | 'fastQuoteLoading' | 'notice' | 'fastAvailability' | 'slowAvailability'
> & { accent?: FlowAccent; slowStatus: AgglayerEligibility };

/** The Fast / Slow route cards and their notice, shared by every route step's layout. */
export const RouteOptions: React.FC<RouteOptionsProps> = ({
  route,
  onRouteChange,
  fastFeeUsd,
  fastQuoteLoading,
  notice,
  slowStatus,
  fastAvailability,
  slowAvailability,
  accent = 'brand'
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
      <RouteCard
        emoji="⚡"
        label={t('fast')}
        selected={route === 'epoch'}
        onSelect={() => select('epoch')}
        fee={fastFee}
        eta={t('fastArrival')}
        disabled={isFeatureBlocked(fastAvailability)}
        testId="bridge-route-fast"
        accent={accent}
      />
      <RouteCard
        emoji="🕐"
        label={t('slow')}
        selected={route === 'agglayer' && slowAllowed}
        disabled={!slowAllowed || isFeatureBlocked(slowAvailability)}
        loading={slowStatus === 'loading'}
        onSelect={() => select('agglayer')}
        fee={slowFee}
        eta={t('slowArrival')}
        testId="bridge-route-slow"
        accent={accent}
      />
      {slowNotice && (
        <p role="status" className="text-xs text-muted">
          {slowNotice}
        </p>
      )}
      {notice && <p className="text-xs text-muted">{notice}</p>}
      <FeatureUnavailableNotice
        availability={fastAvailability.state === 'unavailable' ? fastAvailability : slowAvailability}
        variant="inline"
      />
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
