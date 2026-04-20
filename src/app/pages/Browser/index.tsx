/**
 * Browser tab — entry point used by `PageRouter`.
 *
 * The old `src/app/pages/Browser.tsx` (single-file, ~390 LOC) is replaced by
 * this directory module. The split lets PR-3 hoist the webview lifecycle to
 * a `DappBrowserProvider` and PR-4 generalize to multi-instance without
 * touching the route plumbing.
 */

import React, { type FC } from 'react';

import { BrowserScreen } from './BrowserScreen';

const Browser: FC = () => <BrowserScreen />;

export default Browser;
