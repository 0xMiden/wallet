import React, { useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { useChainHealth } from 'lib/miden/chain/chain-health';
import { HealthCheckStatus } from 'lib/miden/chain/monitor-service-client';

export interface ChainInstabilityBannerProps {
  className?: string;
}

export const ChainInstabilityBanner: React.FC<ChainInstabilityBannerProps> = ({ className }) => {
  const { data: status } = useChainHealth();
  const [isDismissed, setIsDismissed] = useState(false);

  const handleDismiss = useCallback(() => {
    setIsDismissed(true);
  }, []);

  const bannerContent = useMemo(() => {
    if (status === HealthCheckStatus.Degraded) {
      return {
        title: 'Chain Performance Degraded',
        message: 'Transactions may be slow or fail.',
        iconColor: '#FEA644' // Orange
      };
    }
    if (status === HealthCheckStatus.Unhealthy) {
      return {
        title: 'Chain Outage Detected',
        message: 'The network is currently down. Please try again later.',
        iconColor: '#EF4444' // Red
      };
    }
    return null;
  }, [status]);

  const showBanner = !isDismissed && bannerContent;

  if (!showBanner) {
    return null;
  }

  return (
    <div className={classNames('h-[56px] flex items-center bg-white px-4 gap-x-2 rounded-t-3xl', className)}>
      <div className="flex items-center">
        <Icon name={IconName.WarningFill} size="md" fill={bannerContent.iconColor} />
      </div>
      <div className="flex-1 flex flex-col justify-center items-start">
        <p className="text-black text-sm font-medium">{bannerContent.title}</p>
        <p className="text-gray-600 text-xs">{bannerContent.message}</p>
      </div>
      <Icon
        name={IconName.Close}
        size="sm"
        fill="currentColor"
        className="cursor-pointer hover:opacity-100 opacity-50"
        onClick={handleDismiss}
      />
    </div>
  );
};
