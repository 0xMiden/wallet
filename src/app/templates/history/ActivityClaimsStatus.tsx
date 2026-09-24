import React from 'react';

import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { durations, useMotion } from 'lib/animation';

/** The thin bar over an Activity view that runs while incoming notes are still being read. */
export const ClaimsLoadingBar = ({ loading }: { loading: boolean }) => {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const loadingTransition = useMotion({
    duration: durations.extraSlow * 2,
    ease: 'linear',
    repeat: reducedMotion ? 0 : Infinity
  });

  return (
    <div className="mx-4 h-0.5 shrink-0 overflow-hidden rounded-full">
      {loading && (
        <motion.div
          role="progressbar"
          aria-label={t('loading')}
          className={reducedMotion ? 'h-full w-full bg-accent-primary' : 'h-full w-1/3 bg-accent-primary'}
          initial={false}
          animate={{ x: reducedMotion ? '0%' : ['-100%', '300%'] }}
          transition={loadingTransition}
        />
      )}
    </div>
  );
};

/**
 * The count of declined transfers that could still be accepted, with Restore. The Decline dialog
 * promises they can be brought back, so every view that lists claims offers it while any exist.
 */
export const RestoreDeclinedTransfers = ({ count, onRestore }: { count: number; onRestore: () => void }) => {
  const { t } = useTranslation();
  if (count === 0) return null;

  return (
    <div className="flex items-center justify-between gap-2 px-4 pt-3 text-xs text-text-secondary-token">
      <span>{t('activityHiddenTransfers', { count })}</span>
      <Button
        variant={ButtonVariant.Secondary}
        size="sm"
        className="w-auto"
        title={t('activityRestoreTransfers')}
        onClick={onRestore}
      />
    </div>
  );
};
