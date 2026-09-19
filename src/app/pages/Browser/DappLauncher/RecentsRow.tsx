/**
 * The dApps the user opened last, as a horizontal row of app tiles, newest first (the provider's
 * `getRecentDapps` already sorts by `lastOpenedAt` desc). The section renders nothing without any.
 *
 * Recents never carry the capsule morph: the same url may sit in a curated section above, which
 * owns it, and a second holder of the layoutId would be drawn at the wrong size.
 */

import React, { type FC } from 'react';

import { type RecentDapp } from 'lib/dapp-browser';

import { DappTile, TileRow } from './DappTile';

/** One screen and a bit: enough to show it scrolls. */
export const MAX_RECENTS = 10;

interface RecentsRowProps {
  recents: RecentDapp[];
  onOpen: (url: string) => void;
}

export const RecentsRow: FC<RecentsRowProps> = ({ recents, onOpen }) => {
  if (recents.length === 0) return null;

  return (
    <TileRow data-testid="explore-recents">
      {recents.slice(0, MAX_RECENTS).map(dapp => (
        <DappTile key={dapp.url} url={dapp.url} name={dapp.name} icon={dapp.favicon} onOpen={onOpen} />
      ))}
    </TileRow>
  );
};
