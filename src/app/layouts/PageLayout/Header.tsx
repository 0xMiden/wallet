import React, { FC, useEffect, useState } from 'react';

import classNames from 'clsx';

import { Button } from 'app/atoms/Button';
import ColorIdenticon from 'app/atoms/ColorIdenticon';
import Name from 'app/atoms/Name';
import { openInFullPage, useAppEnv } from 'app/env';
import { ReactComponent as MaximiseIcon } from 'app/icons/maximise.svg';
import { ReactComponent as MinimiseIcon } from 'app/icons/minimise.svg';
import { Icon, IconName } from 'app/icons/v2';
import ContentContainer from 'app/layouts/ContentContainer';
import AddressChip from 'app/templates/AddressChip';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

const Header: FC = () => {
  const appEnv = useAppEnv();

  const isGeneratingUrl = window.location.href.search('generating-transaction') > -1;

  return (
    <header className={classNames('mx-4 pb-4 border-b border-grey-300/20', appEnv.fullPage && '')}>
      <ContentContainer className="pt-4">
        <div>
          <div className="flex w-full">{!isGeneratingUrl && <Control />}</div>
        </div>
      </ContentContainer>
    </header>
  );
};

export default Header;

const SyncSpinner: FC<{ visible: boolean }> = ({ visible }) => (
  <div
    className="animate-spin sync-spinner-fade"
    style={{
      width: 16,
      height: 16,
      border: '2px solid #E5E7EB',
      borderTopColor: '#F97316',
      borderRadius: '50%',
      opacity: visible ? 1 : 0,
      transition: 'opacity 300ms ease-in-out'
    }}
  />
);

const Control: FC = () => {
  const account = useAccount();
  const { popup, sidePanel, compact } = useAppEnv();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { isLoading: isLoadingBalances } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const hasCompletedInitialSync = useWalletStore(s => s.hasCompletedInitialSync);
  const isSyncing = isLoadingBalances || !hasCompletedInitialSync;

  // Show spinner only if syncing takes > 1s, then fade out over 300ms
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    if (isSyncing) {
      const showTimeout = setTimeout(() => setShowSpinner(true), 1000);
      return () => clearTimeout(showTimeout);
    }
    const hideTimeout = setTimeout(() => setShowSpinner(false), 300);
    return () => clearTimeout(hideTimeout);
  }, [isSyncing]);

  const handleMaximiseViewClick = async () => {
    const chromeApi = (globalThis as any).chrome;
    const hasSidePanel = isExtension() && chromeApi?.sidePanel?.open;

    if (sidePanel && hasSidePanel) {
      // Switch back to popup mode
      chromeApi.storage.local.set({ sidepanel_mode: false });
      chromeApi.action.setPopup({ popup: 'popup.html' });
      chromeApi.sidePanel
        .setPanelBehavior({ openPanelOnActionClick: false })
        .catch((err: Error) => console.warn('[Header] setPanelBehavior error:', err));
      window.close();
      return;
    }
    if (popup && hasSidePanel) {
      // Switch to side panel mode
      try {
        await chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        chromeApi.action.setPopup({ popup: '' });
        chromeApi.storage.local.set({ sidepanel_mode: true });
        const win = await chromeApi.windows.getLastFocused();
        await chromeApi.sidePanel.open({ windowId: win.id });
        window.close();
        return;
      } catch (err) {
        // Restore popup mode on failure
        chromeApi.action.setPopup({ popup: 'popup.html' });
        chromeApi.storage.local.set({ sidepanel_mode: false });
        chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
        console.warn('[Header] Side panel open failed, falling back to fullpage:', err);
      }
    }
    openInFullPage();
    if (compact) {
      window.close();
    }
  };

  return (
    <>
      <div className={classNames('flex', 'justify-between', 'w-full')}>
        <div className={classNames('flex', 'justify-start')}>
          <div className="flex items-center">
            <Button
              className={classNames(
                'flex',
                'rounded-full items-center justify-center',
                'transition ease-in-out duration-200',
                'cursor-pointer'
              )}
              onClick={() => navigate('/select-account')}
            >
              <ColorIdenticon publicKey={account.publicKey} className="rounded-full h-8 w-8" />
            </Button>
            <div className="flex flex-col pl-2">
              <Name className={classNames('text-sm font-semibold leading-none', 'text-heading-gray')}>
                {account.name}
              </Name>
              <AddressChip address={account.publicKey} className="p-[2.25px]" />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {showSpinner && <SyncSpinner visible={isSyncing} />}
          {compact && (
            <Button
              className={classNames(
                'flex items-center justify-center',
                'rounded-md',
                'transition ease-in-out duration-200',
                'cursor-pointer',
                'opacity-90 hover:opacity-100',
                'h-7 w-7'
              )}
              onClick={handleMaximiseViewClick}
            >
              {sidePanel ? (
                <MinimiseIcon className="w-5 h-5 stroke-heading-gray" />
              ) : (
                <MaximiseIcon className="w-5 h-5 stroke-heading-gray" />
              )}
            </Button>
          )}
          <Button
            className="flex items-center justify-center cursor-pointer h-7 w-7"
            onClick={() => {
              hapticLight();
              navigate('/settings');
            }}
          >
            <Icon
              name={IconName.SettingsNew}
              className="w-6 h-6 stroke-heading-gray fill-heading-gray"
              fill="currentColor"
            />
          </Button>
        </div>
      </div>
    </>
  );
};
