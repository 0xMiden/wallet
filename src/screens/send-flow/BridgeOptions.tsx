import React, { useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { hapticLight } from 'lib/mobile/haptics';
import { DetailCard, DetailRow } from 'lib/ui/DetailCard';

import { EpochQuoteState } from './useEpochQuote';

/** Bridge route → underlying provider. Fast = Epoch (settles in seconds), Slow = Agglayer. */
export type BridgeRoute = 'epoch' | 'agglayer';

const EPOCH_ROUTE = { id: 'epoch' as const, emoji: '⚡', labelKey: 'fast', arrivesKey: 'seconds' };
const AGGLAYER_ROUTE = { id: 'agglayer' as const, emoji: '🕐', labelKey: 'slow', arrivesKey: 'minutes' };
const ROUTES = [EPOCH_ROUTE, AGGLAYER_ROUTE];

export interface BridgeOptionsProps {
  /** Controlled selected route. Omit to let the component own the state. */
  route?: BridgeRoute;
  onRouteChange?: (route: BridgeRoute) => void;
  /** Forward-quote preview for the Fast (Epoch) route. */
  quote?: EpochQuoteState;
}

/**
 * Cross-chain (Ethereum) bridge controls shown in place of the Miden "Advanced
 * Options" when the recipient is an `0x` address. A segmented Fast/Slow toggle
 * picks the route (Epoch vs Agglayer); the details below are time-only for now —
 * fees aren't a thing on testnet, so only the arrival estimate is shown.
 */
export const BridgeOptions: React.FC<BridgeOptionsProps> = ({ route: controlledRoute, onRouteChange, quote }) => {
  const { t } = useTranslation();
  const [internalRoute, setInternalRoute] = useState<BridgeRoute>('epoch');
  const route = controlledRoute ?? internalRoute;
  const active = route === 'agglayer' ? AGGLAYER_ROUTE : EPOCH_ROUTE;

  // The Fast (Epoch) route forward-quotes the EVM output; show it (or a skeleton).
  const showQuoteRow = route === 'epoch' && !!quote && (quote.loading || quote.amount !== undefined);

  const selectRoute = (next: BridgeRoute) => {
    if (next === route) return;
    hapticLight();
    setInternalRoute(next);
    onRouteChange?.(next);
  };

  return (
    <div className="flex flex-col gap-4 pb-4 w-full">
      {/* Fast / Slow route toggle */}
      <div className="flex rounded-[10px] bg-input-bg p-1">
        {ROUTES.map(r => (
          <button
            key={r.id}
            type="button"
            onClick={() => selectRoute(r.id)}
            className={clsx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-semibold transition-colors',
              route === r.id ? 'bg-pure-white text-heading-gray shadow-sm' : 'text-heading-gray/40'
            )}
          >
            <span aria-hidden>{r.emoji}</span>
            {t(r.labelKey)}
          </button>
        ))}
      </div>
      {/* Details — estimated output (Epoch) + arrival time (no fees on testnet) */}
      <DetailCard>
        {showQuoteRow && (
          <DetailRow label={t('youReceive')}>
            {quote!.loading ? (
              <div className="h-4 w-20 animate-pulse rounded bg-heading-gray/10" />
            ) : (
              <span className="text-sm font-semibold text-heading-gray">{`≈ ${quote!.amount} ${quote!.symbol}`}</span>
            )}
          </DetailRow>
        )}
        <DetailRow label={t('arrives')} isLast>
          <span className="flex items-center gap-1.5 text-sm font-semibold text-heading-gray">
            <span className="h-1.5 w-1.5 rounded-full bg-heading-gray" />
            {t(active.arrivesKey)}
          </span>
        </DetailRow>
      </DetailCard>
    </div>
  );
};
