import React from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

export interface NavButtonProps {
  icon: IconName;
  /** Already-translated accessible name, e.g. "Back" or "Close". */
  label: string;
  onClick: () => void;
  /** Glyph color class. Defaults to the grey glyph; a flow passes its accent. */
  iconClassName?: string;
  /** `circle`: the round filled button. `bare`: a 24px glyph alone in a 44px hit area, for page headers. */
  appearance?: 'circle' | 'bare';
  className?: string;
  'data-testid'?: string;
}

/**
 * The round navigation button: back and close, in the screen header and in a flow's top row.
 * One component because four hand-written copies had already drifted - the screen header's close
 * was the one that did not buzz.
 */
export const NavButton: React.FC<NavButtonProps> = ({
  icon,
  label,
  onClick,
  iconClassName = 'text-heading-gray',
  appearance = 'circle',
  className,
  'data-testid': dataTestId
}) => (
  <button
    type="button"
    onClick={() => {
      hapticLight();
      onClick();
    }}
    aria-label={label}
    data-testid={dataTestId}
    className={classNames(
      'flex shrink-0 items-center justify-center rounded-full',
      appearance === 'bare' ? 'h-11 w-11 -mx-2.5' : 'h-9 w-9 bg-surface-nav-button',
      className
    )}
  >
    <Icon name={icon} size={appearance === 'bare' ? 'md' : 'sm'} fill="currentColor" className={iconClassName} />
  </button>
);
