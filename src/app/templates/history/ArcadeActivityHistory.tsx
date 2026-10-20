import React, { useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { EmptyState } from 'components/ui/EmptyState';
import { Notice } from 'components/ui/Notice';
import { ARCADE_PATH, arcadeActivityMatcher } from 'lib/arcade';
import { getExploreCatalog } from 'lib/dapp-browser/explore-catalog';
import { useExploreCatalog } from 'lib/explore-config/use-explore-catalog';
import { navigate } from 'lib/woozie';

import { ActivityPendingHistory } from './ActivityPendingHistory';

/** The existing Activity feed, narrowed to recorded requests from current-network catalog games. */
export const ArcadeActivityHistory: React.FC<{
  search: string;
  programId?: string | null;
  onInitialLoad?: () => void;
}> = props => {
  const { t } = useTranslation();
  const catalog = useExploreCatalog();
  const predicate = useMemo(() => arcadeActivityMatcher(getExploreCatalog(catalog ?? null)), [catalog]);
  // A slot waiting for game activity: dashed like Game Coins, with the way into the Arcade and the
  // filter's scope as a footnote under it.
  const emptyState = (
    <div className="flex flex-col gap-3" data-testid="arcade-activity-empty">
      <EmptyState
        surface="dashed"
        icon={IconName.Rocket}
        title={t('arcadeActivityEmptyTitle')}
        description={t('arcadeActivityEmptyBody')}
        secondaryAction={{ label: t('arcadeBrowseGames'), onClick: () => navigate(ARCADE_PATH) }}
        className="w-full"
      />
      <Notice
        variant="inline"
        icon={<Icon name={IconName.Information} size="sm" fill="currentColor" />}
        data-testid="arcade-activity-scope"
      >
        {t('arcadeActivityScope')}
      </Notice>
    </div>
  );
  return (
    <ActivityPendingHistory
      {...props}
      filter="arcade"
      predicate={predicate}
      catalogPending={catalog === undefined}
      emptyState={emptyState}
    />
  );
};
