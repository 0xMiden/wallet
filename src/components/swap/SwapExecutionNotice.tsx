import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';

export interface SwapExecutionNoticeProps {
  outputSymbol?: string;
  className?: string;
}

/**
 * Concise context for protocol swaps. iETH needs an additional explanation
 * because its symbol is easy to mistake for native ETH on Ethereum.
 */
export const SwapExecutionNotice: FC<SwapExecutionNoticeProps> = ({ outputSymbol, className }) => {
  const { t } = useTranslation();
  const isIeth = outputSymbol?.toUpperCase() === 'IETH';

  return (
    <div
      data-testid="swap-execution-notice"
      className={classNames(
        'flex w-full items-start gap-2 rounded-10 bg-surface-interactive px-3 py-3 text-xs text-heading-gray',
        className
      )}
    >
      <Icon name={IconName.Information} size="xs" className="mt-0.5 shrink-0 text-heading-gray" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        {isIeth && <p>{t('swapIethExplanation')}</p>}
        <p>{t('swapExecutionVenueExplanation')}</p>
      </div>
    </div>
  );
};
