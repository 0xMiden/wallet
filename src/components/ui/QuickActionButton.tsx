import React from 'react';

import { motion } from 'framer-motion';

import { Icon, type IconName } from 'app/icons/v2';
import { usePreset } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';

/** A compact icon-and-label action. The whole label and icon share one native tap target. */
export const QuickActionButton: React.FC<{
  icon: IconName;
  label: string;
  onClick: () => void;
  'data-testid'?: string;
}> = ({ icon, label, onClick, 'data-testid': testId }) => {
  const press = usePreset('press');
  return (
    <motion.button
      type="button"
      {...press}
      onClick={() => {
        hapticLight();
        onClick();
      }}
      data-testid={testId}
      className="flex min-h-11 min-w-0 flex-1 flex-col items-center gap-2 rounded-2xl px-1 py-2 text-action text-ink outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-accent-primary"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-fill text-accent-tint-ink">
        <Icon name={icon} size="md" />
      </span>
      <span className="w-full break-words text-center">{label}</span>
    </motion.button>
  );
};
