import React, { FC } from 'react';

import { ReactComponent as InfoIcon } from 'app/icons/info-alert.svg';

interface InformationBannerProps {
  title: string;
  bodyText: string;
}

const InformationBanner: FC<InformationBannerProps> = ({ title, bodyText }) => {
  return (
    <div className="flex flex-row items-start rounded-lg p-4 bg-blue-300 dark:bg-blue-500/15">
      <span className="pt-px">
        <InfoIcon className="mr-2 h-5 w-5" />
      </span>
      <div>
        <h4 className="font-medium text-sm mb-1">{title}</h4>
        <p>{bodyText}</p>
      </div>
    </div>
  );
};

export default InformationBanner;
