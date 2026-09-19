import React from 'react';

import clsx from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';

export interface EmptyStateSecondaryAction {
  label: string;
  onClick: () => void;
  'data-testid'?: string;
}

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: IconName;
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
  title,
  description,
  secondaryAction,
  ...props
}) => {
  return (
    <div
      {...props}
      className={clsx(
        'flex flex-col items-center justify-center gap-3 rounded-2xl bg-fill px-6 py-10 text-center',
        className
      )}
    >
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-page text-muted">
        <Icon name={icon} fill="currentColor" size="md" />
      </div>
      <div className="flex flex-col items-center gap-1">
        <h3 className="font-heading text-[17px] font-extrabold leading-tight text-ink">{title}</h3>
        {description && <p className="text-sm leading-tight text-muted">{description}</p>}
      </div>
      {secondaryAction && (
        <Button
          data-testid={secondaryAction['data-testid']}
          variant={ButtonVariant.Secondary}
          className="mt-1 h-9 w-auto px-4 text-sm"
          onClick={secondaryAction.onClick}
          title={secondaryAction.label}
        />
      )}
    </div>
  );
};
