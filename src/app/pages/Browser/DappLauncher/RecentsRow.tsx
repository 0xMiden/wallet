/**
 * The dApps the user opened last, as a vertical list, newest first (the provider's `getRecentDapps`
 * already sorts by `lastOpenedAt` desc). Each row is the dApp's logo tile, its name over its host, and
 * an outward arrow: the row leaves the wallet for the dApp. The section renders nothing without any.
 */

import React, { type FC } from 'react';

import { Icon, IconName } from 'app/icons/v2';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { type RecentDapp } from 'lib/dapp-browser';

import { AppIcon } from './AppIcon';

function hostOf(dapp: RecentDapp): string {
  try {
    return new URL(dapp.url).hostname;
  } catch {
    return dapp.origin;
  }
}

interface RecentsRowProps {
  recents: RecentDapp[];
  onOpen: (url: string) => void;
}

export const RecentsRow: FC<RecentsRowProps> = ({ recents, onOpen }) => {
  if (recents.length === 0) return null;

  return (
    <div className="px-4" data-testid="explore-recents">
      <ListGroup surface="plain">
        {recents.map(dapp => (
          <ListRow
            key={dapp.url}
            title={dapp.name}
            subtitle={hostOf(dapp)}
            // `page`, as on Explore's other lists: a plain group has no surface of its own.
            avatar={<AppIcon url={dapp.url} name={dapp.name} icon={dapp.favicon} size="row" surface="page" />}
            trailing={<Icon name={IconName.ArrowRightUp} size="sm" className="text-muted" />}
            onClick={() => onOpen(dapp.url)}
            aria-label={dapp.name}
            data-testid="recent-dapp-row"
            dataAttributes={{ 'data-dapp-url': dapp.url }}
          />
        ))}
      </ListGroup>
    </div>
  );
};
