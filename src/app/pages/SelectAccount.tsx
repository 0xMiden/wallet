import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import ColorIdenticon from 'app/atoms/ColorIdenticon';
import Name from 'app/atoms/Name';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount, useAllAccounts, useMidenContext } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
import { goBack, navigate, useLocation } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

const SelectAccount: FC = () => {
  const { t } = useTranslation();

  const { updateCurrentAccount } = useMidenContext();
  const allAccounts = useAllAccounts();
  const account = useAccount();
  const { search } = useLocation();

  // Check for ?created=1 query param
  const showAccountCreated = search.includes('fromCreateAccount=true');

  const onAddAccountClick = () => {
    navigate('/create-account');
  };

  return (
    <>
      <NavigationHeader title={t('Accounts')} showBorder className="bg-gray-25" onBack={() => navigate('/')} />
      {showAccountCreated && <AccountCreatedSucess />}
      <div
        className={classNames('flex flex-1 justify-between w-full verflow-y-auto pt-6', isMobile() ? 'px-6' : 'px-3')}
      >
        <div className={classNames('my-2', 'w-full')}>
          <div className="flex flex-col gap-3">
            {allAccounts.map(acc => {
              const selected = acc.publicKey === account.publicKey;
              const handleAccountClick = async () => {
                if (!selected) {
                  await updateCurrentAccount(acc.publicKey);
                  navigate('/');
                }
              };

              return (
                <div
                  key={acc.publicKey}
                  className={classNames(
                    'flex w-full rounded-[10px]',
                    'overflow-hidden py-3 px-4',
                    'flex items-center',
                    'text-heading-gray',
                    'transition ease-in-out duration-200',
                    'cursor-pointer',
                    'mb-1',
                    'hover:bg-gray-100 active:bg-gray-300',
                    selected ? 'bg-gray-25' : ''
                  )}
                  style={{ height: '64px' }}
                  onClick={handleAccountClick}
                >
                  <ColorIdenticon publicKey={acc.publicKey} className="shrink-0" size="lg" />

                  <div className="flex flex-col items-start ml-2">
                    <div className="flex flex-col text-left gap-1">
                      <Name className="font-semibold leading-none text-xl">{acc.name}</Name>
                      <div className="flex w-full items-start">
                        <span>
                          {acc.isPublic ? t('public') : t('private')} • {truncateAddress(acc.publicKey, true, 8)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col w-full p-6 md:px-8 m-auto">
        <Button title={t('addAccount')} variant={ButtonVariant.Primary} onClick={onAddAccountClick} />
      </div>
    </>
  );
};

export const AccountCreatedSucess = () => {
  const { t } = useTranslation();
  return (
    <div className={classNames('pt-6', isMobile() ? 'px-6' : 'px-3')}>
      <div className="w-full border-[#00802680] border rounded-[10px] h-12 flex items-center justify-center">
        <div className="w-full flex items-center justify-center gap-2 text-[#008026] font-semibold text-base">
          <CheckMark />
          {t('accountCreationSucess')}
        </div>
      </div>
    </div>
  );
};

export const CheckMark = () => {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M14.2501 8.56249C14.3639 8.44461 14.4269 8.28674 14.4255 8.12287C14.4241 7.95899 14.3583 7.80223 14.2425 7.68635C14.1266 7.57047 13.9698 7.50474 13.806 7.50332C13.6421 7.5019 13.4842 7.56489 13.3663 7.67874L8.80382 12.2412L6.74132 10.1787C6.62345 10.0649 6.46557 10.0019 6.3017 10.0033C6.13783 10.0047 5.98107 10.0705 5.86519 10.1864C5.74931 10.3022 5.68358 10.459 5.68215 10.6229C5.68073 10.7867 5.74372 10.9446 5.85757 11.0625L8.35757 13.5625C8.47478 13.6797 8.63372 13.7455 8.79945 13.7455C8.96518 13.7455 9.12412 13.6797 9.24132 13.5625L14.2413 8.56249H14.2501Z"
        fill="#008026"
      />
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M10 0C4.475 0 0 4.475 0 10C0 15.525 4.475 20 10 20C15.525 20 20 15.525 20 10C20 4.475 15.525 0 10 0ZM1.25 10C1.25 5.1625 5.1625 1.25 10 1.25C14.8375 1.25 18.75 5.1625 18.75 10C18.75 14.8375 14.8375 18.75 10 18.75C5.1625 18.75 1.25 14.8375 1.25 10Z"
        fill="#008026"
      />
    </svg>
  );
};

export default SelectAccount;
