import React, { FC, useCallback, useEffect, useSyncExternalStore } from 'react';

import { useTranslation } from 'react-i18next';

import { useOnboardingFinishing } from 'app/onboarding-finish';
import { recordOpenedDapp } from 'app/pages/Browser/record-opened-dapp';
import { useDappBrowser, useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { resolveRootView } from 'app/root-view';
import { AlertSheet } from 'components/ui/AlertSheet';
import { createDappSession, parseOrigin } from 'lib/dapp-browser';
import {
  getPendingOpenLink,
  startOpenLinkCapture,
  subscribePendingOpenLink,
  takePendingOpenLink
} from 'lib/dapp-browser/open-link';
import type { ExploreCatalog } from 'lib/explore-config/schema';
import { useExploreCatalog } from 'lib/explore-config/use-explore-catalog';
import { OUTSIDE_WALLET_SHELL_ROUTES } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';

function isListed(catalog: ExploreCatalog | null, page: string): boolean {
  const origin = parseOrigin(page);
  return catalog?.items.some(item => parseOrigin(item.url) === origin) ?? false;
}

/**
 * Opens the page an open link (`https://bread.miden.xyz/open#url=…`) names in the dApp browser. It
 * waits for the wallet to be open, so a link that arrives on the lock screen, during onboarding, behind
 * the hot-key rotation gate or on a recovery screen opens after it. A page on the origin of an app
 * Explore lists opens straight away; any other page asks first, because anyone can publish a link.
 */
export const OpenLinkPrompt: FC = () => {
  const { t } = useTranslation();
  const { open } = useDappBrowser();
  const { pathname } = useLocation();
  const { locked, ready, hydrated } = useMidenContext();
  const finishingOnboarding = useOnboardingFinishing();
  const rotationGated = useWalletStore(s => Boolean(s.currentAccount?.requiresHotKeyRotation));
  const page = useSyncExternalStore(subscribePendingOpenLink, getPendingOpenLink, getPendingOpenLink);

  useEffect(() => startOpenLinkCapture(), []);

  const walletOpen =
    resolveRootView({ locked, ready, hydrated, finishingOnboarding }) === 'app' &&
    !rotationGated &&
    !OUTSIDE_WALLET_SHELL_ROUTES.has(pathname);
  // Loaded only for a link: Explore's refresh otherwise starts with the Browser tab. Undefined until the network's
  // floor is read, and a listed page cannot be told apart before then.
  const catalog = useExploreCatalog(page !== null && walletOpen);
  const due = page !== null && walletOpen && catalog !== undefined;
  const listed = due && isListed(catalog, page);
  const confirming = due && !listed;

  const openPage = useCallback(() => {
    const url = takePendingOpenLink();
    if (!url) return;
    open(createDappSession(url));
    void recordOpenedDapp(url);
    if (pathname !== '/browser') navigate('/browser');
  }, [open, pathname]);

  useEffect(() => {
    if (listed) openPage();
  }, [listed, openPage]);

  useHideForegroundDappWhileOpen(confirming);

  return (
    <AlertSheet
      open={confirming}
      title={t('openLinkTitle', { host: page ? new URL(page).host : '' })}
      actionLabel={t('openLinkAction')}
      onAction={openPage}
      onCancel={takePendingOpenLink}
      cancelLabel={t('cancel')}
      actionTestId="open-link-open"
      cancelTestId="open-link-cancel"
      screenKey="open-link"
    >
      {t('openLinkDescription')}
    </AlertSheet>
  );
};
