import React, { FC, useEffect, useState } from 'react';

import { Trans, useTranslation } from 'react-i18next';

import Spinner from 'app/atoms/Spinner/Spinner';
import { IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Message } from 'components/Message';
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
      className="flex flex-col bg-app-bg overflow-hidden w-full h-full mx-auto"
      style={{ maxWidth: 420 }}
    >
      {!ready ? (
        <div className="flex flex-col flex-1 items-center justify-center gap-y-4 px-6 text-center">
          <Spinner />
          <p className="text-text-muted text-sm">{t('creatingYourWallet')}</p>
        </div>
      ) : (
        <div className="w-full h-full pt-11.5">
          <div className="flex-1 flex flex-col h-full justify-between gap-y-8 w-full px-6">
            <div className="flex flex-col items-center grow">
              <Message
                icon={IconName.Success}
                iconSize="3xl"
                iconClassName="mb-8"
                title={
                  <Trans
                    i18nKey="yourWalletIsReady"
                    components={{ highlight: <span className="text-primary-500" /> }}
                  />
                }
                description=""
              />
            </div>
            <div className="flex flex-col mt-auto items-center gap-y-3 w-full pb-8">
              <Button
                tabIndex={0}
                title={t('openWallet')}
                className="self-center w-full text-base"
                onClick={onOpen}
                isLoading={opening}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OpenSidePanel;
