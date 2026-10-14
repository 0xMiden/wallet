import React, { createContext, useContext } from 'react';

import { cn } from 'lib/ui/util';

import { Pill } from './Pill';
import { outlineSurfaceClassName } from './surfaces';

/** `sans` (default) is Inter; `heading` sets the whole card in Nunito with semibold row labels. */
export type DetailCardFace = 'sans' | 'heading';

const DetailCardFaceContext = createContext<DetailCardFace>('sans');

export interface DetailRowAction {
  label: string;
  onClick: () => void;
  /** For an action that opens a sheet or menu. */
  'aria-haspopup'?: 'dialog' | 'menu';
  'data-testid'?: string;
}

export interface DetailRowProps {
  label: string;
  /** The value. A long value (an address) wraps instead of truncating. */
  children: React.ReactNode;
  /** Secondary line under the value, e.g. a fee note. */
  sub?: React.ReactNode;
  /**
   * Rendered right after the label — an `InfoHint`, for a row whose explanation is a sentence.
   * A sentence belongs here rather than in `sub`: three wrapped lines under a value push the
   * rows apart and make the card read as prose.
   */
  info?: React.ReactNode;
  /** Inline action after the value, e.g. "Edit": a small selected `Pill`, whose tint ink clears 4.5:1 (Rule 6). */
  action?: DetailRowAction;
  /** Stack the value under the label, for values too long to sit beside it (e.g. a full address). */
  stacked?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** One label/value row of a `DetailCard`. */
export const DetailRow: React.FC<DetailRowProps> = ({
  label,
  children,
  sub,
  info,
  action,
  stacked = false,
  className,
  'data-testid': dataTestId
}) => {
  const face = useContext(DetailCardFaceContext);
  return (
    <div
      data-testid={dataTestId}
      className={cn('flex gap-x-4 gap-y-1 px-4 py-3', stacked ? 'flex-col' : 'items-start', className)}
    >
      <span
        className={cn(
          'flex shrink-0 items-center gap-0.5 text-body-sm text-muted',
          !stacked && 'min-w-20',
          face === 'heading' && 'font-semibold'
        )}
      >
        {label}
        {info}
      </span>
      <div className={cn('flex min-w-0 flex-1 flex-col gap-1', stacked ? 'items-start' : 'items-end text-right')}>
        <div className={cn('flex max-w-full items-center gap-2 text-value text-ink', stacked && 'break-all')}>
          {children}
          {action && (
            <Pill
              size="sm"
              tone="selected"
              onClick={action.onClick}
              aria-haspopup={action['aria-haspopup']}
              data-testid={action['data-testid']}
              className="shrink-0"
            >
              {action.label}
            </Pill>
          )}
        </div>
        {sub && <span className="text-caption text-muted">{sub}</span>}
      </div>
    </div>
  );
};

/**
 * A card of label/value rows with hairline dividers between them, 16px radius: on `fill` by default,
 * or with `surface="outline"` on the page with a hairline border, like `Card`'s outline surface.
 * `face="heading"` sets it in Nunito, as on the send and swap reviews.
 */
export const DetailCard: React.FC<{
  children: React.ReactNode;
  surface?: 'fill' | 'outline';
  face?: DetailCardFace;
  className?: string;
}> = ({ children, surface = 'fill', face = 'sans', className }) => (
  <DetailCardFaceContext.Provider value={face}>
    <div
      className={cn(
        'divide-y divide-hairline rounded-2xl',
        surface === 'outline' ? outlineSurfaceClassName : 'bg-fill',
        face === 'heading' && 'face-heading',
        className
      )}
    >
      {children}
    </div>
  </DetailCardFaceContext.Provider>
);
