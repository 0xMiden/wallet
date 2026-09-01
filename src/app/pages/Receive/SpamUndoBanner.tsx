import React, { FC, useEffect } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { springs, useMotion } from 'lib/animation';
import { SpamAction } from 'lib/miden/note-spam';
import { hapticLight } from 'lib/mobile/haptics';

export interface SpamUndoBannerProps {
  /** The last hide/block; `null` renders nothing. */
  action: SpamAction | null;
  onUndo: () => void;
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 6000;

const messageKey = (action: SpamAction): string => {
  switch (action.kind) {
    case 'hide-note':
      return 'spamBannerNoteHidden';
    case 'block-faucet':
      return 'spamBannerAssetBlocked';
    case 'block-sender':
      return 'spamBannerSenderBlocked';
    case 'block-sender-and-faucet':
      return 'spamBannerSenderAndAssetBlocked';
  }
};

/**
 * Inline "Moved to spam — Undo" strip above the pending list. Auto-dismisses;
 * the action stays reversible from the spam bin after that.
 */
export const SpamUndoBanner: FC<SpamUndoBannerProps> = ({ action, onUndo, onDismiss }) => {
  const { t } = useTranslation();
  const transition = useMotion(springs.standard);

  useEffect(() => {
    if (!action) return;
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [action, onDismiss]);

  return (
    <AnimatePresence initial={false}>
      {action && (
        <motion.div
          key={`${action.kind}`}
          role="status"
          data-testid="spam-undo-banner"
          className="flex items-center gap-x-2 rounded-2xl bg-status-negative/10 px-4 py-3 text-status-negative"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={transition}
        >
          <Icon name={IconName.Bin} size="xs" fill="currentColor" className="shrink-0" />
          <p className="min-w-0 flex-1 text-xs font-medium leading-snug">{t(messageKey(action))}</p>
          <button
            type="button"
            data-testid="spam-undo-button"
            onClick={() => {
              hapticLight();
              onUndo();
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-bold hover:bg-status-negative/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-status-negative"
          >
            {t('undo')}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
