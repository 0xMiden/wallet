import React from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

export interface ScreenHeaderProps {
  title: React.ReactNode;
  /** Leading back affordance (orange circular arrow). Omit for a back-less header. */
  onBack?: () => void;
  backLabel?: string;
  /** Trailing close (X) affordance. Omit for a close-less header. */
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}

export const ScreenHeader: React.FC<ScreenHeaderProps> = ({
  title,
  onBack,
  backLabel,
  onClose,
  closeLabel,
  className
}) => (
  <div className={classNames('flex items-center gap-4 border-b border-border-faint py-4', className)}>
    {/* Back and close are the same nav button: a flat circle on the nav button
        surface with a grey glyph, rather than an outlined orange arrow. */}
    {onBack && (
      <button
        type="button"
        onClick={() => {
          hapticLight();
          onBack();
        }}
        aria-label={backLabel}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-nav-button"
      >
        <Icon name={IconName.BackArrow} size="sm" fill="currentColor" className="text-heading-gray" />
      </button>
    )}
    {/* No heading at all when there is no title, rather than an empty one: the
        success receipts render a title-less header (their title lives in the body,
        under the hero), and an `<h1></h1>` announced a nameless level-1 heading
        before it. The spacer keeps the close button pinned right. */}
    {title ? (
      <h1 className="flex-1 font-heading text-[1.75rem] font-extrabold leading-none text-heading-gray">{title}</h1>
    ) : (
      <div className="flex-1" />
    )}
    {onClose && (
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-nav-button"
      >
        <Icon name={IconName.Close} size="sm" fill="currentColor" className="text-heading-gray" />
      </button>
    )}
  </div>
);
