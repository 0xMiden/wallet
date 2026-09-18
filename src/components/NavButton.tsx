import React from 'react';

import { IconName } from 'app/icons/v2';
import { IconButton } from 'components/ui/IconButton';

export interface NavButtonProps {
  icon: IconName;
  /** Already-translated accessible name, e.g. "Back" or "Close". */
  label: string;
  onClick: () => void;
  /** `circle`: the round filled button. `bare`: a 24px glyph alone in a 44px hit area, for page headers. */
  appearance?: 'circle' | 'bare';
  className?: string;
  'data-testid'?: string;
}

/**
 * Thin wrapper over the design system's `IconButton` (`components/ui/IconButton`), kept only
 * because `ScreenHeader` — retired by a later branch in this stack — still imports it under this
 * older name. New code uses `IconButton` directly; see `PageHeader`. Delete this file, and
 * `ScreenHeader`'s import of it, together once `ScreenHeader` is gone.
 */
export const NavButton: React.FC<NavButtonProps> = ({
  icon,
  label,
  onClick,
  appearance = 'circle',
  className,
  'data-testid': dataTestId
}) => (
  <IconButton
    icon={icon}
    label={label}
    onClick={onClick}
    appearance={appearance}
    // `circle` here keeps the screen header's previous 36px target; `IconButton`'s own default
    // (32px) is for the sheets/overlays the spec calls out.
    circleSize={appearance === 'circle' ? '36' : undefined}
    className={className}
    data-testid={dataTestId}
  />
);
