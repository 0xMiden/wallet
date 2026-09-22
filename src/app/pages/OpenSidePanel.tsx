import React, { FC, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { closeOnboardingTab, openSidePanelToWallet } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { navigate } from 'lib/woozie';

// Escape hatch if creation never reports Ready — e.g. the service worker died
// before broadcasting its post-create state, or a silently-failed import.
// Comfortably longer than even a slow Guardian creation, so it only fires on a
// genuine stall.
const READY_TIMEOUT_MS = 60_000;

/**
 * Onboarding → side panel handoff completion screen (Chrome).
 *
 * Reached at `/finish-side-panel` once the onboarding tab has kicked off wallet
 * creation. It deliberately lives on its own route (rendered regardless of the
 * Ready state) so creating the wallet — which flips the app to the wallet home
 * — doesn't route the fullpage away before the user can open the panel.
 *
 * While the wallet is still being created it shows a spinner; once Ready, the
 * "Open wallet" button opens the side panel onto the finished wallet and closes
 * this tab. The open runs inside the button's user gesture, which
 * `sidePanel.open()` requires.
 */
const OpenSidePanel: FC = () => {
  const { t } = useTranslation();
  const { ready } = useMidenContext();
  const [opening, setOpening] = useState(false);

  // Don't spin forever if Ready never arrives — bail to the wallet home (which
  // shows Explore when ready, or the onboarding screen if creation truly
  // failed). Cleared as soon as Ready flips.
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => navigate('/'), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  const onOpen = async () => {
    setOpening(true);
    const opened = await openSidePanelToWallet();
    if (opened) {
      // tabs.remove() destroys this page. closeOnboardingTab returns false for
      // the window's last tab — closing that would close the panel too — so
      // fall back to showing the wallet in this tab.
      const closed = await closeOnboardingTab();
      if (!closed) {
        setOpening(false);
        navigate('/');
      }
    } else {
      setOpening(false);
      navigate('/');
    }
  };

  // Match the onboarding flow's centered, max-width container (this screen is
  // rendered directly by PageRouter, not inside OnboardingFlow's wrapper).
  //
  // `finish-side-panel` is the only unambiguous hook for this screen: both the
  // `yourWalletIsReady` title and the `openWallet` button title are shared
  // verbatim with `Confirmation.tsx`, so an E2E check for either of those alone
  // also matches the screen the handoff was reached FROM.
  return (
    <div
      data-testid="finish-side-panel"
      className="mx-auto flex h-full w-full max-w-[420px] flex-col overflow-hidden bg-app-bg"
    >
      {!ready ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-y-4 px-4 text-center">
          <Spinner />
          <p className="font-sans text-[15px] leading-[22px] text-muted">{t('creatingYourWallet')}</p>
        </div>
      ) : (
        <SubPageLayout
          footer={
            <Button tabIndex={0} title={t('openWallet')} className="max-w-none" onClick={onOpen} isLoading={opening} />
          }
        >
          <Hero
            nameAs="h1"
            className="my-auto py-6"
            visual={
              <span className="flex size-16 items-center justify-center rounded-full bg-positive-tint text-positive-tint-ink">
                <Icon name={IconName.Success} size="lg" aria-hidden="true" />
              </span>
            }
            name={t('yourWalletIsReady')}
          />
        </SubPageLayout>
      )}
    </div>
  );
};

export default OpenSidePanel;
