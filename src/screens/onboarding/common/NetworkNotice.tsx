import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { isDevnet } from 'utils/brand-colors';

export interface NetworkNoticeScreenProps {
  onSubmit?: () => void;
}

interface NoticeRow {
  icon: IconName;
  titleKey: string;
  bodyKey: string;
}

const NOTICE_ROWS: NoticeRow[] = [
  { icon: IconName.CloseCircle, titleKey: 'networkNoticeNoValueTitle', bodyKey: 'networkNoticeNoValueBody' },
  { icon: IconName.WarningFill, titleKey: 'networkNoticeNoRealFundsTitle', bodyKey: 'networkNoticeNoRealFundsBody' },
  { icon: IconName.Refresh, titleKey: 'networkNoticeResetTitle', bodyKey: 'networkNoticeResetBody' }
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
          <div className="inline-flex self-start items-center gap-2 h-8 pl-2 pr-3 rounded-full border border-dashed border-primary-orange-light bg-primary-orange-lighter dark:border-primary-orange-dark dark:bg-primary-orange-darker">
            <BreadLogo aria-hidden="true" className="size-[18px] shrink-0" />
            <span className="font-heading text-xs font-bold uppercase tracking-wider text-primary-orange-dark dark:text-primary-orange-light">
              {t('networkNoticeChip', { network })}
            </span>
          </div>

          <h1 className="text-[2.125rem] font-extrabold font-heading text-heading-gray mt-4 leading-[112%] tracking-tight">
            {t('networkModeBanner', { network })}
          </h1>
          <p className="text-[15px] leading-[147%] text-text-secondary-token mt-3">{t('networkNoticeBody')}</p>

          <ul className="flex flex-col divide-y divide-rule-default mt-6">
            {NOTICE_ROWS.map(row => (
              <li key={row.titleKey} className="flex items-start gap-3.5 py-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-orange-lighter text-primary-orange dark:bg-primary-orange-darker">
                  <Icon name={row.icon} size="sm" fill="currentColor" />
                </span>
                <span className="flex flex-col gap-1 min-w-0">
                  <span className="text-[15px] font-semibold leading-5 text-text-primary-token">{t(row.titleKey)}</span>
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
