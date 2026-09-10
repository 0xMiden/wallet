import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { cn } from 'lib/ui/util';
import { isDevnet } from 'utils/brand-colors';

export interface NetworkChipProps {
  /**
   * Locale key for the chip text. It receives the build network name as the
   * `$network$` placeholder ("Testnet", or "Devnet" on devnet builds).
   */
  labelKey: string;
  className?: string;
}

/**
 * Small Bread-branded pill that names the Miden network this build runs on.
 * Shared by the onboarding network notice and the Receive screen so the
 * network is called out the same way wherever funds can enter the wallet.
 */
export const NetworkChip: FC<NetworkChipProps> = ({ labelKey, className }) => {
  const { t } = useTranslation();
  const network = isDevnet ? t('devnet') : t('testnet');

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 h-8 pl-2 pr-3 rounded-full border border-dashed border-primary-orange-light bg-primary-orange-lighter dark:border-primary-orange-dark dark:bg-primary-orange-darker',
        className
      )}
      data-testid="network-chip"
    >
      <BreadLogo aria-hidden="true" className="size-[18px] shrink-0" />
      <span className="font-heading text-xs font-bold uppercase tracking-wider text-primary-orange-dark dark:text-primary-orange-light">
        {t(labelKey, { network })}
      </span>
    </div>
  );
};
