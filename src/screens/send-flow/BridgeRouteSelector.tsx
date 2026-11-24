import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { FlowAccent } from 'components/flow/accent';
import { Avatar } from 'components/ui/Avatar';
import { ChoiceCardGroup } from 'components/ui/ChoiceCard';
import { SegmentedControl } from 'components/ui/SegmentedControl';

import { BridgeRouteMetrics, BridgeRouteRanking, rankBridgeRoutes } from './route-ranking';

export interface BridgeRouteChoice extends BridgeRouteMetrics {
  id: string;
  provider: string;
  providerLogo?: string;
  /** Already-localized quote display values. Never derive quantities from the ranking metrics. */
  receiveLabel: string;
  costLabel: string;
  etaLabel: string;
}

export interface BridgeRouteSelectorProps {
  /** Only routes quoted for the same source amount and destination asset belong in one list. */
  routes: readonly BridgeRouteChoice[];
  selectedId?: string;
  onSelect: (id: string) => void;
  accent?: FlowAccent;
}

/** Provider comparison view. The caller owns quote validity, eligibility and explicit selection. */
export const BridgeRouteSelector: React.FC<BridgeRouteSelectorProps> = ({
  routes,
  selectedId,
  onSelect,
  accent = 'receive'
}) => {
  const { t } = useTranslation();
  const [ranking, setRanking] = useState<BridgeRouteRanking>('best-value');
  const hasChoices = routes.length > 1;
  const descriptionKey =
    ranking === 'best-value'
      ? 'bridgeRankValueDescription'
      : ranking === 'cheapest'
        ? 'bridgeRankCostDescription'
        : 'bridgeRankTimeDescription';

  return (
    <div className="flex w-full flex-col gap-3">
      {hasChoices && (
        <>
          <SegmentedControl
            items={[
              { id: 'best-value', label: t('bridgeRankBestValue') },
              { id: 'cheapest', label: t('bridgeRankCheapest') },
              { id: 'fastest', label: t('bridgeRankFastest') }
            ]}
            value={ranking}
            onChange={setRanking}
            layout="fill"
            accent={accent}
            aria-label={t('bridgeRouteSort')}
          />
          <p className="text-caption text-muted" role="status">
            {t(descriptionKey)}
          </p>
        </>
      )}
      <ChoiceCardGroup
        aria-label={t('bridgeRouteProviders')}
        value={selectedId ?? null}
        onChange={onSelect}
        accent={accent}
        items={rankBridgeRoutes(routes, ranking).map(route => ({
          id: route.id,
          title: route.provider,
          disabled: route.disabled,
          leading: (
            <Avatar
              size={24}
              image={route.providerLogo}
              icon={<Icon name={IconName.Globe} size="xs" className="text-ink" />}
              className="bg-fill-pressed"
            />
          ),
          'data-testid': `route-choice-${route.id}`,
          data: { 'data-route-id': route.id },
          details: (
            <>
              <span className="flex flex-col gap-1">
                <span className="text-caption text-muted">{t('youReceive')}</span>
                <span className="text-title-section text-ink">{route.receiveLabel}</span>
              </span>
              <span className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                <span className="text-caption text-muted">
                  {t('bridgeEstimatedCost')} <span className="text-value text-ink">{route.costLabel}</span>
                </span>
                <span className="text-caption text-muted">
                  {t('bridgeArrivalEstimate')} <span className="text-value text-ink">{route.etaLabel}</span>
                </span>
              </span>
            </>
          )
        }))}
      />
    </div>
  );
};
