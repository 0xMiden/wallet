/**
 * Explore's app lists, on the same components as the Settings list: a `ListGroup surface="plain"`
 * of `ListRow`s, so the rows sit on the page margin under their section title, divided by
 * full-width hairlines. Each row is one tap target that opens the app: its 40px logo tile, the
 * app's name over its tagline, and the chevron every navigating row carries.
 */

import React, { type FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { type ExploreItem } from 'lib/dapp-browser';

import { AppIcon } from './AppIcon';

export interface AppRowProps {
  item: ExploreItem;
  onOpen: (url: string) => void;
}

export const AppRow: FC<AppRowProps> = ({ item, onOpen }) => {
  const { t } = useTranslation();

  return (
    <ListRow
      title={item.name}
      subtitle={item.taglineKey ? t(item.taglineKey) : item.tagline}
      // `page`, not `fill`: a plain group has no surface of its own, so the tile sits on the page.
      avatar={<AppIcon url={item.url} name={item.name} icon={item.icon} size="row" surface="page" />}
      // The row opens the app, so it says so the way every other navigating row does — with the
      // chevron, not a tinted pill repeating the row's own job. The row navigates through `onClick`
      // (the dApp browser, not a route), so the chevron is asked for explicitly.
      chevron
      onClick={() => onOpen(item.url)}
      aria-label={item.name}
      data-testid="dapp-grid-card"
      // The E2E driver picks a row out of the shared testid by the app it opens.
      dataAttributes={{ 'data-dapp-url': item.url }}
    />
  );
};

export interface AppListProps {
  items: ExploreItem[];
  onOpen: (url: string) => void;
}

export const AppList: FC<AppListProps> = ({ items, onOpen }) => (
  <ListGroup surface="plain">
    {items.map(item => (
      <AppRow key={item.id} item={item} onOpen={onOpen} />
    ))}
  </ListGroup>
);
