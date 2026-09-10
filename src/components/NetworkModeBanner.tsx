import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { isDevnet } from 'utils/brand-colors';

/**
 * Persistent banner that tells the user which Miden network this build runs on.
 * The network name is a build-time constant: `MIDEN_NETWORK=devnet` shows
 * "Devnet", every other build shows "Testnet". The colors come from the
 * network-conditional brand ramp, so the devnet build shows the slate palette.
 */
export const NetworkModeBanner: FC = () => {
  const { t } = useTranslation();
  const network = isDevnet ? t('devnet') : t('testnet');

  return (
    <div
      role="status"
      className="flex h-11 shrink-0 items-center justify-center gap-2 border-b border-dashed border-primary-orange-light bg-primary-orange-lighter px-4 dark:border-primary-orange-dark dark:bg-primary-orange-darker"
      data-testid="network-mode-banner"
    >
      <BreadLogo aria-hidden="true" className="size-[18px] shrink-0" />
      <span className="font-heading text-sm font-bold text-primary-orange-dark dark:text-primary-orange-light">
        {t('networkModeBanner', { network })}
      </span>
    </div>
  );
};
