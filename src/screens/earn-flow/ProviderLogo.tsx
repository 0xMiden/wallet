import React, { FC } from 'react';

import classNames from 'clsx';

import aaveLogoUrl from 'app/icons/earn-provider-logos/aave.svg?url';

/** A lending protocol's mark: its logo where the app ships one, otherwise its initial. */
export const ProviderLogo: FC<{ protocol: string; className?: string }> = ({ protocol, className }) => (
  <span className={classNames('flex shrink-0 items-center justify-center', className)} aria-hidden="true">
    {protocol === 'Aave' ? (
      <img src={aaveLogoUrl} alt="" className="h-full w-full object-contain" />
    ) : (
      protocol.charAt(0)
    )}
  </span>
);
