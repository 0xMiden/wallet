import React, { FC, useEffect, useState } from 'react';

import classNames from 'clsx';

import { Button } from 'app/atoms/Button';
import ColorIdenticon from 'app/atoms/ColorIdenticon';
import Name from 'app/atoms/Name';
import { openInFullPage, useAppEnv } from 'app/env';
import { ReactComponent as ChevronDownIcon } from 'app/icons/chevron-down.svg';
import { ReactComponent as MaximiseIcon } from 'app/icons/maximise.svg';
import { Icon, IconName } from 'app/icons/v2';
import ContentContainer from 'app/layouts/ContentContainer';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { Link, navigate } from 'lib/woozie';

import { HeaderSelectors } from './Header.selectors';
import NetworkSelect from './Header/NetworkSelect';

const Header: FC = () => {
  const appEnv = useAppEnv();

  const isGeneratingUrl = window.location.href.search('generating-transaction') > -1;

  return (
    <header className={classNames('px-4', appEnv.fullPage && '')}>
      <ContentContainer className="py-3.75">
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
  const { popup } = useAppEnv();
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

  const handleMaximiseViewClick = () => {
    openInFullPage();
    if (popup) {
      window.close();
    }
  };

  return (
    <>
      <div className={classNames('flex', 'justify-between', 'w-full')}>
        <div className={classNames('flex', 'justify-start')}>
          <Link to={'/select-account'} testID={HeaderSelectors.AccountDropdown} className="flex">
            <Button
              className={classNames(
                'flex',
                'rounded-md items-center justify-center',
                'transition ease-in-out duration-200',
                'cursor-pointer'
              )}
            >
              <ColorIdenticon publicKey={account.publicKey} />
              <div className="flex overflow-x-hidden ml-2 leading-9 items-center gap-1">
                <Name className={classNames('text-sm', 'text-black')}>{account.name}</Name>
                <ChevronDownIcon style={{ height: 16, width: 'auto' }} />
              </div>
            </Button>
          </Link>
        </div>
        <div className="flex items-center gap-1">
          {showSpinner && <SyncSpinner visible={isSyncing} />}
          {popup && (
            <Button
              className={classNames(
                'flex items-center justify-center',
                'rounded-md',
                'transition ease-in-out duration-200',
                'cursor-pointer',
                'opacity-90 hover:opacity-100',
                'h-6 w-6'
              )}
              onClick={handleMaximiseViewClick}
            >
              <MaximiseIcon className="w-4 h-4" style={{ stroke: '#000', strokeWidth: '2px' }} />
            </Button>
          )}
          <Button
            className="flex items-center justify-center cursor-pointer h-5 w-5"
            onClick={() => {
              hapticLight();
              navigate('/settings');
            }}
          >
            <Icon name={IconName.SettingsNew} className="w-5 h-5" />
          </Button>
        </div>
      </div>
    </>
  );
};
