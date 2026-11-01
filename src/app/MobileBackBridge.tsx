import { FC } from 'react';

import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { goBack, HistoryAction, navigate, useLocation } from 'lib/woozie';

// Tab pages that should go to home on back (when no history)
const TAB_PAGES = ['/history', '/browser'];

/**
 * Bridges hardware back button/gesture with Woozie navigation.
 *
 * This is the lowest-priority back handler (registered first, called last).
 * Higher-priority handlers (dialogs, Navigator flows, onboarding) can intercept first.
 *
 * Behavior:
 * - Settings subpage (/settings/xxx): pop one entry, or land on /me when
 *   the page was opened cold — these are real routes now and can nest, so
 *   jumping straight to the list would skip the page the chevron goes back to
 * - Me's pushed pages: pop one entry, or land on Me when opened cold
 * - Tab pages (history, Me, browser): go to home
 * - If historyPosition > 0: go back in history
 * - Other pages with no history: go to home
 * - Home with no history: return false (let system handle - minimize on Android)
 */
export const MobileBackBridge: FC = () => {
  const { pathname, historyPosition } = useLocation();

  const inHome = pathname === '/';
  const isProfileSubpage = pathname === '/settings' || pathname === '/me/badges';
  const isSettingsSubpage = pathname.startsWith('/settings/') && !isProfileSubpage;
  const isTabPage = pathname === '/me' || TAB_PAGES.some(tab => pathname === tab || pathname.startsWith(tab + '/'));

  useMobileBackHandler(() => {
    // Use history for nested pages. A page opened without history returns to Profile.
    if (isSettingsSubpage || isProfileSubpage) {
      if (historyPosition > 0) {
        goBack();
      } else {
        navigate('/me', HistoryAction.Replace);
      }
      return true;
    }

    // Tab pages (history, Me, browser) -> go to home
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
  }, [pathname, historyPosition, inHome, isSettingsSubpage, isTabPage, isProfileSubpage]);

  return null;
};
