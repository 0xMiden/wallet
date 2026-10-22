import React, { FC } from 'react';

import classNames from 'clsx';

import aaveLogoUrl from 'app/icons/earn-provider-logos/aave.svg?url';

/** True for an Aave protocol name: "Aave", or a version of it such as "Aave V3". */
const isAave = (protocol: string): boolean => protocol === 'Aave' || protocol.startsWith('Aave ');

/**
 * A lending protocol's mark: its logo where the app ships one, otherwise its initial, drawn in ink so it
 * reads on both themes (inside a CardButton it would otherwise take the button's UA text colour).
 */
export const ProviderLogo: FC<{ protocol: string; className?: string }> = ({ protocol, className }) => (
  <span className={classNames('flex shrink-0 items-center justify-center text-ink', className)} aria-hidden="true">
    {isAave(protocol) ? (
      <img src={aaveLogoUrl} alt="" className="h-full w-full object-contain" />
    ) : (
      protocol.charAt(0)
    )}
  </span>
);
