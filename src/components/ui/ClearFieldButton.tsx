import React from 'react';

import { useTranslation } from 'react-i18next';

// The svg module directly, never the `app/icons/v2` barrel: TextField renders this button, and
// the barrel's module graph evaluates ahead of a suite's own module mock factories.
import { ReactComponent as CloseCircleFillIcon } from 'app/icons/v2/close-circle-fill.svg';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface ClearFieldButtonProps {
  /** Empties the field and leaves focus in it. */
  onClear: () => void;
  /** Layout only: where the button sits in its field. */
  className?: string;
}

/**
 * The clear (x) action inside a field: the `muted` close-circle glyph in a 44px hit area, named
 * "Clear", with the tap haptic. Mount it only while the field holds something to clear.
 */
export const ClearFieldButton: React.FC<ClearFieldButtonProps> = ({ onClear, className }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t('clear')}
      // A press must not take focus from the field: the blur would run its owner's onBlur (a
      // touched flag, a validation) for a value that is about to be gone.
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        hapticLight();
        onClear();
      }}
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent-primary',
        className
      )}
    >
      <CloseCircleFillIcon aria-hidden="true" className="h-5 w-5" fill="currentColor" />
    </button>
  );
};
