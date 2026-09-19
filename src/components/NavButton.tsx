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
      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-nav-button',
      className
    )}
  >
    <Icon name={icon} size="sm" fill="currentColor" className={iconClassName} />
  </button>
);
