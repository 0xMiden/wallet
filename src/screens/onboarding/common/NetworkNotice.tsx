import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { NetworkChip } from 'components/NetworkChip';
import { isDevnet } from 'utils/brand-colors';

export interface NetworkNoticeScreenProps {
  onSubmit?: () => void;
}

interface NoticeRow {
  titleKey: string;
  bodyKey: string;
}

const NOTICE_ROWS: NoticeRow[] = [
  { titleKey: 'networkNoticeNoValueTitle', bodyKey: 'networkNoticeNoValueBody' },
  { titleKey: 'networkNoticeNoRealFundsTitle', bodyKey: 'networkNoticeNoRealFundsBody' },
  { titleKey: 'networkNoticeResetTitle', bodyKey: 'networkNoticeResetBody' }
];

/**
 * Onboarding notice shown after the first tap on Welcome, before the user
 * creates or restores a wallet. It names the network this build runs on and
 * explains that the tokens are test tokens. The network label is a build-time
 * constant, so a devnet build says "Devnet".
 */
export const NetworkNoticeScreen: React.FC<NetworkNoticeScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();
  const network = isDevnet ? t('devnet') : t('testnet');

  return (
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-network-notice">
      <div className="min-h-full flex flex-col px-6">
        <div className="flex-1 flex flex-col w-full pt-8 pb-6">
          <NetworkChip labelKey="networkNoticeChip" className="self-start" />

          <h1 className="text-[2.125rem] font-extrabold font-heading text-heading-gray mt-4 leading-[112%] tracking-tight">
            {t('networkModeBanner', { network })}
          </h1>
          <p className="text-[15px] leading-[147%] text-text-secondary-token mt-3">{t('networkNoticeBody')}</p>

          <ul className="flex flex-col divide-y divide-rule-default mt-6">
            {NOTICE_ROWS.map(row => (
              <li key={row.titleKey} className="py-4">
                <span className="flex flex-col gap-1 min-w-0">
                  <span className="text-lg font-semibold leading-5 text-text-primary-token">{t(row.titleKey)}</span>
                  <span className="text-sm leading-5 text-text-secondary-token">{t(row.bodyKey)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="w-full flex flex-col items-center pb-6 shrink-0">
          <Button title={t('iUnderstand')} data-testid="onboarding-network-notice-acknowledge" onClick={onSubmit} />
        </div>
      </div>
    </div>
  );
};

export default NetworkNoticeScreen;
