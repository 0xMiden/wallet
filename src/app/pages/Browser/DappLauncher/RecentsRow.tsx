/**
 * The dApps the user opened last, as a horizontal row of app tiles, newest first (the provider's
 * `getRecentDapps` already sorts by `lastOpenedAt` desc). The section renders nothing without any.
 */

import React, { type FC } from 'react';

import { type RecentDapp } from 'lib/dapp-browser';

import { DappTile, TileRow } from './DappTile';

interface RecentsRowProps {
  recents: RecentDapp[];
  onOpen: (url: string) => void;
}

export const RecentsRow: FC<RecentsRowProps> = ({ recents, onOpen }) => {
  if (recents.length === 0) return null;

  return (
    <TileRow data-testid="explore-recents">
      {recents.map(dapp => (
        <DappTile key={dapp.url} url={dapp.url} name={dapp.name} icon={dapp.favicon} onOpen={onOpen} />
      ))}
    </TileRow>
  );
};
