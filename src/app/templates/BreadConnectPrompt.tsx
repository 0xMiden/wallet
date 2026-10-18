import React, { FC, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useTranslation } from 'react-i18next';

import { useOnboardingFinishing } from 'app/onboarding-finish';
import { useDappBrowser, useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { resolveRootView } from 'app/root-view';
import { AlertSheet } from 'components/ui/AlertSheet';
import { answerRequestLink } from 'lib/bread-connect/answer';
import {
  nextRequestLink,
  startRequestLinkCapture,
  subscribeRequestLinks,
  takeRequestLink
} from 'lib/bread-connect/capture';
import { openCallback } from 'lib/bread-connect/opener';
import { OUTSIDE_WALLET_SHELL_ROUTES } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { useLocation } from 'lib/woozie';

type Notice = { kind: 'waiting' | 'unreturned' | 'unreturned-transaction'; host: string };

/**
 * Answers what other apps ask through Bread Connect links (`https://bread.miden.xyz/request#…`), one at a time and
 * once the wallet is open. Bread asks the user exactly as it asks a website with the app's origin, finishes an
 * approved transaction, then switches back to the app with the answer. A foreground dApp is parked so the
 * confirmation sheet shows.
 */
export const BreadConnectPrompt: FC = () => {
  const { t } = useTranslation();
  const { park, session } = useDappBrowser();
  const { pathname } = useLocation();
  const { locked, ready, hydrated } = useMidenContext();
  const finishingOnboarding = useOnboardingFinishing();
  const rotationGated = useWalletStore(s => Boolean(s.currentAccount?.requiresHotKeyRotation));
  const link = useSyncExternalStore(subscribeRequestLinks, nextRequestLink, nextRequestLink);
  const [answering, setAnswering] = useState(false);
  // Taking a link re-renders through the link store before `answering` is set, so the effect checks this instead.
  const answeringRef = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => startRequestLinkCapture(), []);

  const walletOpen =
    resolveRootView({ locked, ready, hydrated, finishingOnboarding }) === 'app' &&
    !rotationGated &&
    !OUTSIDE_WALLET_SHELL_ROUTES.has(pathname);

  useEffect(() => {
    if (link === null || !walletOpen || answeringRef.current) return;
    const taken = takeRequestLink();
    if (!taken) return;
    answeringRef.current = true;
    setAnswering(true);
    setNotice(null);
    void (async () => {
      try {
        if (session) await park();
        const answer = await answerRequestLink(taken, {
          onTransactionSent: callback => setNotice({ kind: 'waiting', host: new URL(callback).host })
        });
        if (!answer) return;
        setNotice(null);
        if (await openCallback(answer.link)) {
          await answer.keep?.();
          return;
        }
        const host = new URL(answer.callback).host;
        setNotice({ kind: answer.sentTransaction ? 'unreturned-transaction' : 'unreturned', host });
      } catch (error) {
        console.warn('[bread-connect] answering a request failed:', error);
        setNotice(null);
      } finally {
        answeringRef.current = false;
        setAnswering(false);
      }
    })();
  }, [link, walletOpen, answering, park, session]);

  useHideForegroundDappWhileOpen(notice !== null);

  const dismiss = () => setNotice(null);
  const waiting = notice?.kind === 'waiting';

  return (
    <AlertSheet
      open={notice !== null}
      title={t(waiting ? 'breadConnectWaitingTitle' : 'breadConnectUnreturnedTitle', { host: notice?.host ?? '' })}
      actionLabel={t('ok')}
      onAction={dismiss}
      actionTestId="bread-connect-ok"
      screenKey="bread-connect"
    >
      {t(
        waiting
          ? 'breadConnectWaitingDescription'
          : notice?.kind === 'unreturned-transaction'
            ? 'breadConnectUnreturnedTransactionDescription'
            : 'breadConnectUnreturnedDescription',
        { host: notice?.host ?? '' }
      )}
    </AlertSheet>
  );
};
