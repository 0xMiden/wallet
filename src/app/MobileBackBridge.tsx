import { FC } from 'react';

import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { goBack, HistoryAction, navigate, useLocation } from 'lib/woozie';

// Tab pages that should go to home on back (when no history)
const TAB_PAGES = ['/history', '/settings', '/browser'];

/**
 * Bridges hardware back button/gesture with Woozie navigation.
 *
 * This is the lowest-priority back handler (registered first, called last).
 * Higher-priority handlers (dialogs, Navigator flows, onboarding) can intercept first.
 *
 * Behavior:
 * - Settings subpage (/settings/xxx): go to /settings
 * - Tab pages (history, settings, browser) with no history: go to home
 * - If historyPosition > 0: go back in history
 * - Other pages with no history: go to home
 * - Home with no history: return false (let system handle - minimize on Android)
 */
export const MobileBackBridge: FC = () => {
  const { pathname, historyPosition } = useLocation();

  const inHome = pathname === '/';
  const isSettingsSubpage = pathname.startsWith('/settings/');
  const isTabPage = TAB_PAGES.some(tab => pathname === tab || pathname.startsWith(tab + '/'));

  useMobileBackHandler(() => {
    // Settings subpage -> pop one level, or land on the list on a cold open.
    //
    // Same rule as the header chevron's `useBackWithFallback('/settings')`, and
    // it has to be: the settings sub-screens became real routes, so they can
    // now nest (Keys -> Reveal private key, Authorized dApps -> Connected
    // dApps). Jumping straight to '/settings' from any depth skipped the
    // intermediate page the chevron goes back to, so the two affordances
    // disagreed about where "back" is. As drawers these screens never pushed an
    // entry, so there was nothing to skip.
    if (isSettingsSubpage) {
      if (historyPosition > 0) {
        goBack();
      } else {
        navigate('/settings', HistoryAction.Replace);
      }
      return true;
    }

    // Tab pages (history, settings, browser) -> go to home
    if (isTabPage) {
      navigate('/', HistoryAction.Replace);
      return true;
    }

    // If there's history, go back
    if (historyPosition > 0) {
      goBack();
      return true;
    }

    // No history - if not on home, go to home
    if (!inHome) {
      navigate('/', HistoryAction.Replace);
      return true;
    }

    // On home with no history - let system handle (minimize on Android)
    return false;
  }, [pathname, historyPosition, inHome, isSettingsSubpage, isTabPage]);

  return null;
};
