import React, { FC, useEffect, useState } from 'react';

import classNames from 'clsx';

import { Button } from 'app/atoms/Button';
import ColorIdenticon from 'app/atoms/ColorIdenticon';
import Name from 'app/atoms/Name';
import { openInFullPage, useAppEnv } from 'app/env';
import { ReactComponent as ChevronDownIcon } from 'app/icons/chevron-down.svg';
import { ReactComponent as MaximiseIcon } from 'app/icons/maximise.svg';
import ContentContainer from 'app/layouts/ContentContainer';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { Link } from 'lib/woozie';

import { HeaderSelectors } from './Header.selectors';
import NetworkSelect from './Header/NetworkSelect';

const Header: FC = () => {
  const appEnv = useAppEnv();

  const isGeneratingUrl = window.location.href.search('generating-transaction') > -1;

  return (
    <header className={classNames('px-4', appEnv.fullPage && '', 'border-b-[#00000033] border-b-[0.5px]')}>
      <ContentContainer className="py-[15px]">
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
          <Link to={'/select-account'} testID={HeaderSelectors.AccountDropdown}>
            <Button
              className={classNames(
                'flex-shrink-0 flex',
                'rounded-md items-center',
                'transition ease-in-out duration-200',
                'cursor-pointer'
              )}
            >
              <ColorIdenticon publicKey={account.publicKey} />
              <div className="self-start flex overflow-x-hidden ml-2 leading-9">
                <Name className={classNames('text-sm', 'text-black')}>{account.name}</Name>
                <ChevronDownIcon
                  className="ml-1 -mr-1 stroke-2"
                  style={{ height: 16, width: 'auto', marginTop: '10px' }}
                />
              </div>
            </Button>
          </Link>
        </div>
        <div className="flex items-center gap-2">
          {showSpinner && <SyncSpinner visible={isSyncing} />}
          <NetworkSelect className="self-end" />
          {popup && (
            <Button
              className={classNames(
                'flex items-center justify-center',
                'rounded-md',
                'transition ease-in-out duration-200',
                'cursor-pointer',
                'opacity-90 hover:opacity-100',
                'h-8 w-8'
              )}
              onClick={handleMaximiseViewClick}
            >
              <MaximiseIcon className="h-5 w-6" style={{ stroke: '#000', strokeWidth: '2px' }} />
            </Button>
          )}
        </div>
      </div>
    </>
  );
};
