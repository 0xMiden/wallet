import React, { FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import Spinner from 'app/atoms/Spinner/Spinner';
import { IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Message } from 'components/Message';
import { closeOnboardingTab, openSidePanelToWallet } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { navigate } from 'lib/woozie';

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

  const onOpen = async () => {
    setOpening(true);
    const opened = await openSidePanelToWallet();
    if (opened) {
      // tabs.remove() destroys this page. closeOnboardingTab returns false for
      // the window's last tab — closing that would close the panel too — so
      // fall back to showing the wallet in this tab.
      const closed = await closeOnboardingTab();
      if (!closed) navigate('/');
    } else {
      navigate('/');
    }
  };

  if (!ready) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-y-4 bg-app-bg px-6 text-center">
        <Spinner />
        <p className="text-text-muted text-sm">{t('creatingYourWallet')}</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full pt-11.5">
      <div className="flex-1 flex flex-col h-full justify-between bg-app-bg gap-y-8 w-full px-6">
        <div className="flex flex-col items-center grow">
          <Message
            icon={IconName.Success}
            iconSize="3xl"
            iconClassName="mb-8"
            title={t('yourWalletIsReady')}
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
  );
};

export default OpenSidePanel;
