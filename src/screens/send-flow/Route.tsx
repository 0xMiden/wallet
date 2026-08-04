import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { hapticLight } from 'lib/mobile/haptics';

import { BridgeRoute } from './types';

export interface RouteStepProps {
  route: BridgeRoute;
  onRouteChange: (route: BridgeRoute) => void;
  /** Fast-route fee in USD (input value − quoted USDC out). undefined while quoting / unavailable. */
  fastFeeUsd?: number;
  fastQuoteLoading: boolean;
  /** Whether the Slow (Agglayer) route can carry the selected token. */
  slowEnabled: boolean;
  /**
   * Whether the Fast (Epoch) route can carry the selected token. Defaults to
   * `true` — the send flow always offers Fast; the deposit-bridge sheet turns it
   * off for ETH, which is Agglayer-only.
   */
  fastEnabled?: boolean;
  /**
   * Provider captions rendered under each card's label ("via Epoch" /
   * "via Agglayer"). Omitted by the send flow, which names routes by speed only.
   */
  providerLabels?: { fast?: string; slow?: string };
  /**
   * Overrides the arrival ETA of each card. The shared `fastArrival`/`slowArrival`
   * copy describes Miden → EVM; deposits run the other way and are quoted
   * differently, so that call site passes its own strings.
   */
  etaLabels?: { fast?: string; slow?: string };
  /** Extra message rendered below the cards (e.g. a route-specific notice). When set, it replaces the default slow-disabled hint. */
  notice?: React.ReactNode;
  /** Disable the confirm button — e.g. the quote isn't ready, or an unsupported route+token combo. */
  confirmDisabled?: boolean;
  /** Padding classes for the confirm-button footer. The `pb-24` default clears
   *  the floating BottomNav; pass a snugger value when the navbar is hidden. */
  footerClassName?: string;
  onConfirm: () => void;
}

interface RouteCardProps {
  emoji: string;
  label: string;
  /** Optional provider caption under the label ("via Epoch"). */
  caption?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  fee: React.ReactNode;
  eta: string;
  testId?: string;
}

const RouteCard: React.FC<RouteCardProps> = ({ label, caption, selected, disabled, onSelect, fee, eta, testId }) => (
  <button
    type="button"
    data-testid={testId}
    disabled={disabled}
    onClick={onSelect}
    className={clsx(
      'flex w-full items-center rounded-2xl border bg-pure-white px-4 py-6 transition-colors text-base',
      selected ? 'border-primary-500' : 'border-[#E8E8E8]',
      disabled && 'pointer-events-none opacity-40'
    )}
  >
    <div className="flex flex-1 flex-col items-start text-[20px] font-bold text-primary-500">
      <span>{label}</span>
      {caption && <span className="text-xs font-medium text-[#808080]">{caption}</span>}
    </div>
    <span className="h-6 w-px shrink-0 bg-border-card" />
    <div className="flex flex-1 items-center justify-center text-heading-gray font-bold">{fee}</div>
    <span className="h-6 w-px shrink-0 bg-border-card" />
    <div className="flex flex-1 items-center justify-end text-base font-medium text-[#808080]">{eta}</div>
  </button>
);

/**
 * Cross-chain route picker, shown after the destination network is chosen for a
 * 0x recipient. Fast = Epoch (any token → USDC, settles in ~seconds, charges a
 * fee = input value − USDC received); Slow = Agglayer (no fee, ~hours, only the
 * dedicated bridgeable token — disabled otherwise).
 */
export const Route: React.FC<RouteStepProps> = ({
  route,
  onRouteChange,
  fastFeeUsd,
  fastQuoteLoading,
  slowEnabled,
  fastEnabled = true,
  providerLabels,
  etaLabels,
  notice,
  confirmDisabled,
  footerClassName = 'pt-4 pb-24',
  onConfirm
}) => {
  const { t } = useTranslation();

  const select = (next: BridgeRoute) => {
    if (next === route) return;
    hapticLight();
    onRouteChange(next);
  };

  // Built in plain JS (not JSX) so the em-dash fallback doesn't trip the
  // no-literal-string i18n lint; "$1.84" is excluded as a $-prefixed value.
  const feeText = fastFeeUsd != null ? `$${fastFeeUsd.toFixed(2)}` : '—';
  const fastFee = fastQuoteLoading ? (
    <div className="h-4 w-12 animate-pulse rounded bg-heading-gray/10" />
  ) : (
    <span className="text-base font-bold text-heading-gray">{feeText}</span>
  );

  return (
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        <span className="font-heading text-2xl leading-none font-bold text-[#808080]">{t('route')}</span>

        <div className="mt-6 flex flex-col gap-6">
          <RouteCard
            emoji="⚡"
            label={t('fast')}
            caption={providerLabels?.fast}
            selected={route === 'epoch'}
            disabled={!fastEnabled}
            onSelect={() => select('epoch')}
            fee={fastFee}
            eta={etaLabels?.fast ?? t('fastArrival')}
            testId="bridge-route-fast"
          />
          <RouteCard
            emoji="🕐"
            label={t('slow')}
            caption={providerLabels?.slow}
            selected={route === 'agglayer'}
            disabled={!slowEnabled}
            onSelect={() => select('agglayer')}
            fee={<span className="text-base font-bold text-heading-gray">{t('noFee')}</span>}
            eta={etaLabels?.slow ?? t('slowArrival')}
            testId="bridge-route-slow"
          />
          {notice ? (
            <p className="text-xs text-heading-gray/60">{notice}</p>
          ) : (
            !slowEnabled && <p className="text-xs text-heading-gray/50">{t('onlyBridgeableTokenSupported')}</p>
          )}
        </div>
      </div>

      <div className={clsx('shrink-0', footerClassName)}>
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};
