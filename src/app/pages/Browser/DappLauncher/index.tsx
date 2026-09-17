/**
 * Top-level launcher composition for the embedded dApp browser.
 *
 * Stack (top → bottom):
 *   <TabHeader/>         "Explore" title
 *   <AppsGrid/>          Two curated faucet app cards
 *   <RecentsRow/>        1-row of up to 4 recent opens
 *
 * The launcher reads recents from `recent-dapps.ts` storage on mount.
 * Card + tile taps call `onOpen(url)` which the parent
 * (`BrowserScreen`) handles by creating a session and switching to
 * `<DappActive>`.
 */

import React, { type FC, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { TabHeader, TabHeaderAction } from 'components/ui';
import { getRecentDapps, type RecentDapp } from 'lib/dapp-browser';

import { AppsGrid } from './AppsGrid';
import { normalizeUrl } from './HeroSearch';
import { RecentsRow } from './RecentsRow';

interface DappLauncherProps {
  onOpen: (url: string) => void;
  /** PR-1's BrowserScreen still passes this; PR-2 reads recents from storage instead.  */
  recentUrls?: string[];
}

export const DappLauncher: FC<DappLauncherProps> = ({ onOpen }) => {
  const { t } = useTranslation();
  const [recents, setRecents] = useState<RecentDapp[]>([]);
  // Header search, same control as Activity: a dApp name (normalized to a
  // URL) or a pasted URL; submitting opens it and closes the field.
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const toggleSearch = () => {
    setSearchOpen(open => !open);
    setSearch('');
  };
  const submitSearch = (value: string) => {
    const url = normalizeUrl(value);
    if (!url) return;
    setSearchOpen(false);
    setSearch('');
    onOpen(url);
  };

  // Load recents from preferences on mount.
  useEffect(() => {
    let cancelled = false;
    getRecentDapps()
      .then(list => {
        if (!cancelled) setRecents(list);
      })
      .catch(() => {
        if (!cancelled) setRecents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <TabHeader
        title={t('explore')}
        search={{
          open: searchOpen,
          value: search,
          onChange: setSearch,
          placeholder: t('searchDapps'),
          onSubmit: submitSearch
        }}
        actions={
          <TabHeaderAction label={t('searchDapps')} icon={IconName.Search} active={searchOpen} onClick={toggleSearch} />
        }
      />

      <main className="grow space-y-5 overflow-y-auto pb-24 pt-3" style={{ overscrollBehavior: 'contain' }}>
        <AppsGrid onOpen={onOpen} />

        <RecentsRow recents={recents} onOpen={onOpen} />
      </main>
    </>
  );
};
