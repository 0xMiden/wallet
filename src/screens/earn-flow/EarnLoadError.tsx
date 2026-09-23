import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { hapticLight } from 'lib/mobile/haptics';

/**
 * A failed positions load with nothing to fall back on. It must not read as "you have no positions":
 * that would present a network or service problem as an empty portfolio. Shared by Earn and the
 * positions list, so both say the same thing and retry the same way.
 */
export const EarnLoadError: FC<{ onRetry: () => void; className?: string }> = ({ onRetry, className }) => {
  const { t } = useTranslation();

  return (
    <div
      className={classNames('flex flex-col items-center gap-4 text-center', className)}
      data-testid="earn-positions-load-error"
      role="alert"
    >
      <p className="max-w-xs text-base leading-snug text-ink">{t('earnPositionsLoadError')}</p>
      <button
        type="button"
        data-testid="earn-positions-retry"
        onClick={() => {
          hapticLight();
          onRetry();
        }}
        className="rounded-full bg-fill px-5 py-2.5 text-sm font-bold text-ink hover:bg-fill-pressed focus:bg-fill-pressed"
      >
        {t('retry')}
      </button>
    </div>
  );
};
