import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Button } from 'components/Button';
import { NetworkNoticeRows } from 'components/NetworkNoticeRows';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

export interface NetworkNoticeScreenProps {
  onSubmit?: () => void;
}

/**
 * Onboarding notice shown after the first tap on Welcome, before the user
 * creates or restores a wallet. It names the effective network and explains
 * that the tokens are test tokens; on mainnet, which has none, it renders
 * nothing.
 */
export const NetworkNoticeScreen: React.FC<NetworkNoticeScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();
  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);

  return (
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-network-notice">
      <div className="min-h-full flex flex-col px-6">
        <div className="flex-1 flex flex-col w-full pt-8 pb-6">
          <div className="inline-flex items-center gap-2 h-8 pl-2 pr-3 self-start rounded-full border border-dashed border-primary-orange-light bg-primary-orange-lighter dark:border-primary-orange-dark dark:bg-primary-orange-darker">
            <BreadLogo aria-hidden="true" className="size-[18px] shrink-0" />
            <span className="font-heading text-xs font-bold uppercase tracking-wider text-primary-orange-dark dark:text-primary-orange-light">
              {t('networkNoticeChip', { network })}
            </span>
          </div>

          <h1 className="text-[2.125rem] font-extrabold font-heading text-heading-gray mt-4 leading-[112%] tracking-tight">
            {t('networkModeBanner', { network })}
          </h1>
          <p className="text-[15px] leading-[147%] text-text-secondary-token mt-3">{t('networkNoticeBody')}</p>

          <NetworkNoticeRows className="mt-6" />
        </div>

        <div className="w-full flex flex-col items-center pb-6 shrink-0">
          <Button title={t('iUnderstand')} data-testid="onboarding-network-notice-acknowledge" onClick={onSubmit} />
        </div>
      </div>
    </div>
  );
};

export default NetworkNoticeScreen;
