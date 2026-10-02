import React from 'react';

import clsx from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';

import { outlineSurfaceClassName } from './surfaces';

export interface EmptyStateSecondaryAction {
  label: string;
  onClick: () => void;
  'data-testid'?: string;
}

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: IconName;
  /** `fill` (default), or `dashed`: on `page` inside a dashed hairline, for a slot that is waiting to be filled. */
  surface?: 'fill' | 'dashed';
  /**
   * `default`: a centred column, 40px of padding, a 56px icon circle and the 20px section title.
   * `compact`: a slot that should not dominate its section (Earn's positions before there are any) -
   * the same centred stack, icon on top, with 16px of padding, a 40px icon circle and the 16px row
   * title.
   */
  size?: 'default' | 'compact';
  title: string;
  /** Optional: not every empty state needs a second line of copy. */
  description?: string;
  /** A single `secondary` action under the copy, e.g. "Add a contact". */
  secondaryAction?: EmptyStateSecondaryAction;
}

/**
 * Canonical "nothing here" state: `fill` card, 16px radius, a 56px icon
 * circle on `page`, a Nunito title and a `muted` body line, with an optional
 * secondary action. See skills/miden-wallet-frontend/references/design-system.md.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  className,
  icon = IconName.Apps,
  surface = 'fill',
  size = 'default',
  title,
  description,
  secondaryAction,
  ...props
}) => {
  const compact = size === 'compact';
  return (
    <div
      {...props}
      className={clsx(
        'flex flex-col items-center justify-center rounded-2xl text-center',
        // Compact keeps the same centred stack, icon on top, with less padding and a smaller circle.
        compact ? 'gap-2 px-4 py-4' : 'gap-3 px-6 py-10',
        surface === 'fill' ? 'bg-fill' : [outlineSurfaceClassName, 'border-dashed'],
        className
      )}
    >
      <div
        className={clsx(
          'flex shrink-0 items-center justify-center rounded-full text-muted',
          compact ? 'h-10 w-10' : 'h-14 w-14',
          surface === 'fill' ? 'bg-page' : 'bg-fill'
        )}
      >
        <Icon name={icon} fill="currentColor" size={compact ? 'sm' : 'md'} />
      </div>
      <div className="flex flex-col items-center gap-1">
        <h3 className={clsx(compact ? 'text-row-title' : 'text-title-section', 'text-ink')}>{title}</h3>
        {description && <p className="text-body-sm text-muted">{description}</p>}
      </div>
      {secondaryAction && (
        <Button
          data-testid={secondaryAction['data-testid']}
          variant={ButtonVariant.Secondary}
          size="sm"
          className="mt-1 w-auto"
          onClick={secondaryAction.onClick}
          title={secondaryAction.label}
        />
      )}
    </div>
  );
};
