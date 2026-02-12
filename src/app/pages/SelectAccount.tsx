import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import ColorIdenticon from 'app/atoms/ColorIdenticon';
import Name from 'app/atoms/Name';
import { ReactComponent as Checkmark } from 'app/icons/checkmark-alt.svg';
import PageLayout from 'app/layouts/PageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { useAccount, useAllAccounts, useMidenContext } from 'lib/miden/front';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

const SelectAccount: FC = () => {
  const { t } = useTranslation();
  const { updateCurrentAccount } = useMidenContext();
  const allAccounts = useAllAccounts();
  const account = useAccount();

  const onAddAccountClick = () => {
    navigate('/create-account');
  };

  return (
    <PageLayout
      pageTitle={
        <>
          <span className="capitalize">{t('accounts')}</span>
        </>
      }
    >
      <div className="flex flex-1 justify-between w-full px-2 md:px-6 overflow-y-auto" style={{ maxHeight: '29rem' }}>
        <div className={classNames('my-2', 'w-full')}>
          <div className="flex flex-col">
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
                    'flex w-full rounded-lg',
                    'overflow-hidden py-3 px-4',
                    'flex items-center',
                    'text-black text-shadow-black',
                    'transition ease-in-out duration-200',
                    'cursor-pointer',
                    'mb-1',
                    'hover:bg-gray-200 active:bg-gray-300'
                  )}
                  style={{ height: '64px' }}
                  onClick={handleAccountClick}
                >
                  <ColorIdenticon publicKey={acc.publicKey} className="shrink-0" />

                  <div className="flex flex-col items-start ml-2">
                    <div className="flex flex-col text-left">
                      <Name
                        className="font-medium leading-none"
                        style={{ paddingBottom: 3, fontSize: '14px', lineHeight: '20px' }}
                      >
                        {acc.name}
                      </Name>
                      <div className="flex w-full items-start">
                        <span style={{ fontSize: '12px', lineHeight: '16px' }}>
                          {acc.isPublic ? t('public') : t('private')} • {truncateAddress(acc.publicKey)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col grow items-end">
                    <Checkmark className={`mr-1 ${selected ? '' : 'invisible'} w-5 h-5`} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col w-full p-6 md:px-8 m-auto">
        <Button title={t('addAccount')} variant={ButtonVariant.Secondary} onClick={onAddAccountClick} />
      </div>
    </PageLayout>
  );
};

export default SelectAccount;
