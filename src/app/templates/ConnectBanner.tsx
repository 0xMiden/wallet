import React, { FC } from 'react';

import classNames from 'clsx';

import Logo from 'app/atoms/Logo';
import { Icon, IconName } from 'app/icons/v2';
import { DappMetadata } from 'lib/miden/types';

type ConnectBannerProps = {
  type: 'connect';
  origin: string;
  appMeta: DappMetadata;
  className?: string;
};

const ConnectBanner: FC<ConnectBannerProps> = ({ type, origin }) => {
  return (
    <div className={classNames('w-full', 'mb-4', 'flex flex-col')}>
      <div className={classNames('w-full flex items-center justify-center mb-4')}>
        <div className={classNames('border border-gray-100 rounded-3xl', 'flex flex-col items-center', 'p-6')}>
          <Logo className="mb-1" style={{ height: 32, margin: 'auto', filter: '' }} />
        </div>

        <div className="relative w-6 mx-1 h-px bg-gray-300">
          <div className="absolute inset-0 flex items-center justify-center"></div>
        </div>

        <div className={classNames('border border-gray-100 rounded-3xl', 'flex flex-col items-center', 'p-6')}>
          <Icon name={IconName.Globe} fill="currentColor" size="lg" />
        </div>
      </div>
      <span className="font-medium text-center text-[16px] items-center font-semibold">{origin}</span>
    </div>
  );
};

export default ConnectBanner;
