import React from 'react';

import { useTranslation } from 'react-i18next';

import { NetworkLogo } from 'components/NetworkChip';
import { TokenLogo } from 'components/TokenLogo';
import type { BridgeRouteSummary, ClarificationChip } from 'lib/command-ai/orchestrator';
import { cn } from 'lib/ui/util';
import { getBridgeNetwork } from 'screens/send-flow/bridge-networks';

type Translate = (key: string, params?: Record<string, string>) => string;

/** The display name of a route or typed network; a name the wallet does not know stays as given. */
export function bridgeNetworkName(network: string, t: Translate): string {
  if (/^miden(-|$)/i.test(network)) return t('miden');
  return getBridgeNetwork(network.replace(/-mainnet$/, ''))?.name ?? network;
}

export function bridgeProviderName(provider: string, t: Translate): string {
  if (provider === 'near-intents') return t('bridgeRouteNearIntents');
  return ['agglayer', 'epoch', 'xreserve'].includes(provider) ? t(`commandBridgeProvider_${provider}`) : provider;
}

function routeEnds(route: BridgeRouteSummary, t: Translate) {
  return (['source', 'destination'] as const).map(side => ({
    heading: t(side === 'source' ? 'commandBridgeFrom' : 'commandBridgeTo'),
    symbol: route[`${side}Symbol`],
    network: route[`${side}Network`],
    networkName: bridgeNetworkName(route[`${side}Network`], t)
  }));
}

export interface CommandAiChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  chip: ClarificationChip;
  labelClassName: string;
}

/** One answer to an assistant question. A bridge route reads as from, to and provider. */
export function CommandAiChip({ chip, labelClassName, className, ...props }: CommandAiChipProps): React.ReactElement {
  const { t } = useTranslation();
  const { route, addressHint, subtitle } = chip;
  if (!route)
    return (
      <button type="button" className={className} {...props}>
        <span className={labelClassName}>{chip.label}</span>
        {subtitle && <span className="text-caption text-muted">{subtitle}</span>}
      </button>
    );

  const ends = routeEnds(route, t);
  const via = t('commandBridgeVia', { provider: bridgeProviderName(route.provider, t) });
  const name = [...ends.map(end => `${end.heading}: ${end.symbol}, ${end.networkName}`), via, addressHint, subtitle]
    .filter(Boolean)
    .join('. ');
  return (
    <button
      type="button"
      aria-label={name}
      className={cn(className, 'w-full flex-col items-stretch gap-1.5 text-left sm:w-auto')}
      {...props}
    >
      <span className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
        {ends.map(end => (
          <React.Fragment key={end.heading}>
            <span className="text-caption text-muted">{end.heading}</span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5">
                <TokenLogo faucetId={route.midenFaucetId} size="sm" />
                <span className={labelClassName}>{end.symbol}</span>
              </span>
              <span className="flex items-center gap-1.5 text-muted">
                <NetworkLogo kind={end.network.startsWith('miden') ? 'miden' : 'ethereum'} network={end.network} />
                <span>{end.networkName}</span>
              </span>
            </span>
          </React.Fragment>
        ))}
      </span>
      <span className="text-caption text-muted">{[via, subtitle].filter(Boolean).join(' · ')}</span>
      {addressHint && <span className="break-all font-mono text-caption text-muted">{addressHint}</span>}
    </button>
  );
}
