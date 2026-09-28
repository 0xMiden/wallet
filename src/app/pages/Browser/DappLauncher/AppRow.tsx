/**
 * Explore's app lists, on the same components as the Settings list: a `ListGroup surface="plain"`
 * of `ListRow`s, so the rows sit on the page margin under their section title, divided by
 * full-width hairlines. Each row is one tap target that opens the app: its 40px logo tile, the
 * app's name over an optional line (a catalog app's tagline), and the chevron every navigating row
 * carries. The catalog lists and Recents share it.
 */

import React, { type FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { type ExploreItem } from 'lib/dapp-browser';

import { AppIcon } from './AppIcon';

export interface AppRowProps {
  url: string;
  name: string;
  icon?: string;
  subtitle?: string;
  onOpen: (url: string) => void;
  /** Which list the row belongs to, for the E2E driver: `dapp-grid-card` or `recent-dapp-row`. */
  testId: string;
}

export const AppRow: FC<AppRowProps> = ({ url, name, icon, subtitle, onOpen, testId }) => (
  <ListRow
    title={name}
    subtitle={subtitle}
    // `page`, not `fill`: a plain group has no surface of its own, so the tile sits on the page.
    avatar={<AppIcon url={url} name={name} icon={icon} size="row" surface="page" />}
    // The row opens the app, so it says so the way every other navigating row does - with the
    // chevron, not a tinted pill repeating the row's own job. The row navigates through `onClick`
    // (the dApp browser, not a route), so the chevron is asked for explicitly.
    chevron
    onClick={() => onOpen(url)}
    aria-label={name}
    data-testid={testId}
    // The E2E driver picks a row out of the shared testid by the app it opens.
    dataAttributes={{ 'data-dapp-url': url }}
  />
);

export interface AppListProps {
  items: ExploreItem[];
  onOpen: (url: string) => void;
}

export const AppList: FC<AppListProps> = ({ items, onOpen }) => {
  const { t } = useTranslation();

  return (
    <ListGroup surface="plain">
      {items.map(item => (
        <AppRow
          key={item.id}
          url={item.url}
          name={item.name}
          icon={item.icon}
          subtitle={item.taglineKey ? t(item.taglineKey) : item.tagline}
          onOpen={onOpen}
          testId="dapp-grid-card"
        />
      ))}
    </ListGroup>
  );
};
