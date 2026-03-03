import React, { useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { addConnectivityIssue, useConnectivityIssues } from 'lib/miden/activity/connectivity-issues';
import { isExtension } from 'lib/platform';

export interface ConnectivitiyIssueBannerProps {
  className?: string;
}

export const ConnectivityIssueBanner: React.FC<ConnectivitiyIssueBannerProps> = ({ className }) => {
  const { t } = useTranslation();
  const [connectivityIssues, dismissConnectivityIssue] = useConnectivityIssues();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setIsOpen(connectivityIssues);
  }, [connectivityIssues]);

  const onClose = useCallback(() => {
    setIsOpen(false);
    dismissConnectivityIssue();
  }, [dismissConnectivityIssue]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className={classNames('h-[56px] flex items-center bg-white  px-4 gap-x-2 rounded-t-3xl', className)}>
      <div className="flex items-center">
        <Icon name={IconName.WarningFill} size="md" fill="#FEA644" />
      </div>
      <div className="flex-1 flex flex-col justify-center items-start">
        <p className="text-black text-sm font-medium">{t('connectivityIssueDetected')}</p>
        <p className="text-gray-600 text-xs">{t('walletMayBeOffline')}</p>
      </div>
      <Icon
        name={IconName.Close}
        size="sm"
        fill="currentColor"
        className="cursor-pointer hover:opacity-100 opacity-50"
        onClick={onClose}
      />
    </div>
  );
};

export const ExtensionMessageListener = () => {
  useEffect(() => {
    // Extension message listener only available in extension context
    if (!isExtension()) {
      return;
    }

    const handleMessage = (message: any) => {
      if (message.type === 'CONNECTIVITY_ISSUE') {
        console.log('Received connectivity issue from worker:', message.payload);
        addConnectivityIssue();
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  return null;
};
