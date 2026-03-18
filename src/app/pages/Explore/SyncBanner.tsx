import React, { memo } from 'react';

import { useTranslation } from 'react-i18next';

import { openInFullPage, useAppEnv } from 'app/env';
import { ReactComponent as ArrowRightIcon } from 'app/icons/arrow-right.svg';
import { ReactComponent as InformationIcon } from 'app/icons/information.svg';

type SyncBannerProps = {
  syncText: string;
  fullPage: boolean;
};

const SyncBanner = memo<SyncBannerProps>(({ syncText, fullPage }: SyncBannerProps) => {
  const { t } = useTranslation();
  const appEnv = useAppEnv();
  const maximizeClick = () => {
    openInFullPage();
    if (appEnv.popup) {
      window.close();
    }
  };
  return (
    <div className={`w-full bg-primary-500 ${fullPage ? 'rounded-t-lg' : ''}`}>
      <div className="flex p-4 justify-between">
        <div className="h-12 flex flex-col items-stretch justify-center">
          <p
            className="text-lg font-bold text-pure-white flex items-center"
            style={{
              fontSize: '14px',
              lineHeight: '20px'
            }}
          >
            {t('balancePending')}
          </p>
          <div className="flex mt-1">
            <InformationIcon fill="orange" className="mr-1" height="16px" width="16px" />
            <p
              className="text-sm text-pure-white"
              style={{
                fontSize: '12px',
                lineHeight: '16px'
              }}
            >
              {fullPage ? t('keepTabOpenForSync') : t('openNewTabToSync')}
            </p>
          </div>
        </div>
        {fullPage && (
          <div
            className="text-pure-white font-semibold"
            style={{
              fontSize: '22px',
              lineHeight: '24px',
              marginTop: '10px'
            }}
          >
            {syncText}
          </div>
        )}
        {!fullPage && (
          <div className="flex" style={{ marginTop: '5px' }}>
            <div
              className="text-pure-white font-semibold"
              style={{
                fontSize: '14px',
                lineHeight: '20px'
              }}
            >
              {syncText}
            </div>
            <ArrowRightIcon
              fill="white"
              height={'14px'}
              width={'14px'}
              style={{ marginTop: '2px', marginLeft: '24px', cursor: 'pointer' }}
              onClick={maximizeClick}
            />
          </div>
        )}
      </div>
    </div>
  );
});

export default SyncBanner;
