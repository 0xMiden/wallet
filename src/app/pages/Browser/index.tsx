/**
 * Browser tab — entry point used by `PageRouter`.
 *
 * The old `src/app/pages/Browser.tsx` (single-file, ~390 LOC) is replaced by
 * this directory module. The split lets PR-3 hoist the webview lifecycle to
 * a `DappBrowserProvider` and PR-4 generalize to multi-instance without
 * touching the route plumbing.
 */

import React, { type FC } from 'react';

import { EXPLORE_FILTERS } from 'lib/dapp-browser/explore-catalog';
import { HistoryAction, navigate, useLocation } from 'lib/woozie';

import { BrowserScreen } from './BrowserScreen';

const Browser: FC = () => {
  const { pathname, search } = useLocation();
  const asked = pathname === '/browser' ? new URLSearchParams(search).get('category') : null;
  const requestedFilter = EXPLORE_FILTERS.find(filter => filter.id === asked)?.id;
  return (
    <BrowserScreen
      requestedFilter={requestedFilter}
      onChooseFilter={filter =>
        navigate({ pathname: '/browser', search: `?category=${filter}` }, HistoryAction.Replace)
      }
    />
  );
};

export default Browser;
