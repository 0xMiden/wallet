import { getDappDisplayName, parseOrigin, recordRecentDapp } from 'lib/dapp-browser';

import { isSearchUrl } from './DappLauncher/search-url';

/**
 * Recents is a list of dApps the user chose, so a web search this app produced is not one - the
 * other writer, DappActionsSheet's My-dApps toggle, holds the same rule. A page just opened has no
 * title yet, so the shared helper names it by the URL's hostname: a readable name, not the raw
 * `https://…` origin, and the one the bubble, switcher card and capsule derive too.
 */
export function recordOpenedDapp(url: string): Promise<void> {
  if (isSearchUrl(url)) return Promise.resolve();
  return recordRecentDapp({ url, name: getDappDisplayName({ url }), origin: parseOrigin(url) }).catch(() => {});
}
