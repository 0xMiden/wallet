import React from 'react';

import classNames from 'clsx';

import { IconName } from 'app/icons/v2';
import { NavButton } from 'components/NavButton';

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
    {onBack && <NavButton icon={IconName.BackArrow} label={backLabel ?? ''} onClick={onBack} />}
    {/* No heading at all when there is no title, rather than an empty one: the
        success receipts render a title-less header (their title lives in the body,
        under the hero), and an `<h1></h1>` announced a nameless level-1 heading
        before it. The spacer keeps the close button pinned right. */}
    {title ? (
      <h1 className="flex-1 font-heading text-[1.75rem] font-extrabold leading-none text-heading-gray">{title}</h1>
    ) : (
      <div className="flex-1" />
    )}
    {onClose && <NavButton icon={IconName.Close} label={closeLabel ?? ''} onClick={onClose} />}
  </div>
);
