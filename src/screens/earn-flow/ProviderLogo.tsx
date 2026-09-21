import React, { FC } from 'react';

import classNames from 'clsx';

import aaveLogoUrl from 'app/icons/earn-provider-logos/aave.svg?url';

/**
 * A lending protocol's mark. Its own module, not part of `components.tsx`: the `?url` asset import
 * below resolves only through the bundler, so every test file that reached `components.tsx` — even
 * transitively, through a page it renders — had to stub the asset out. Keeping it here leaves the
 * shared earn widgets importable from anywhere.
 */
export const ProviderLogo: FC<{ protocol: string; className?: string }> = ({ protocol, className }) => (
  <span className={classNames('flex shrink-0 items-center justify-center', className)} aria-hidden="true">
    {protocol === 'Aave' ? (
      <img src={aaveLogoUrl} alt="" className="h-full w-full object-contain" />
    ) : (
      protocol.charAt(0)
    )}
  </span>
);
