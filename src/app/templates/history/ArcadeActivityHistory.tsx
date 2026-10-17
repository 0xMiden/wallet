import React, { useMemo } from 'react';

import { arcadeActivityMatcher } from 'lib/arcade';
import { getExploreCatalog } from 'lib/dapp-browser/explore-catalog';
import { useExploreCatalog } from 'lib/explore-config/use-explore-catalog';

import { ActivityPendingHistory } from './ActivityPendingHistory';

/** The existing Activity feed, narrowed to recorded requests from current-network catalog games. */
export const ArcadeActivityHistory: React.FC<{
  search: string;
  programId?: string | null;
  onInitialLoad?: () => void;
}> = props => {
  const catalog = useExploreCatalog();
  const predicate = useMemo(() => arcadeActivityMatcher(getExploreCatalog(catalog ?? null)), [catalog]);
  return (
    <ActivityPendingHistory {...props} filter="arcade" predicate={predicate} catalogPending={catalog === undefined} />
  );
};
