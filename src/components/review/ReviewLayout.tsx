import React from 'react';

import classNames from 'clsx';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';

export interface ReviewAction {
  label: string;
  onPress: () => void;
  /** Defaults to 'button'. Use 'submit' when the screen is inside a <form>. */
  type?: 'button' | 'submit';
  /** Show a spinner and block taps — e.g. while an Epoch bridge quote/solve runs. */
  loading?: boolean;
  /** Disable (without a spinner). */
  disabled?: boolean;
  /** Optional stable selector for E2E; set by the caller, not hardcoded here. */
  'data-testid'?: string;
}

export interface ReviewLayoutProps {
  /** Used for both the header and the in-content section label. */
  title: string;
  /** Small date caption above the title, e.g. "06.06.26". */
  date?: string;
  onBack?: () => void;
  backLabel?: string;
  /** Hero block — a ReviewAmount (send) or a composed swap hero. */
  hero: React.ReactNode;
  /** Divider lines between the detail rows. Default true (send); pass false for swap. */
  dividers?: boolean;
  /** The ReviewRow list. */
  children: React.ReactNode;
  primary: ReviewAction;
  secondary?: ReviewAction;
}

/**
 * Shared shell for review/confirmation screens: header → date → title → hero →
 * orange divider → detail rows → primary/secondary CTAs. Flow-specific content
 * (hero, rows) and callbacks are passed in, so each flow keeps its own confirm
 * logic while sharing one consistent layout. CTA buttons clear the floating
 * BottomNav via pb-24.
 */
export const ReviewLayout: React.FC<ReviewLayoutProps> = ({
  title,
  date,
  onBack,
  backLabel,
  hero,
  dividers = true,
  children,
  primary,
  secondary
}) => (
  <div className="flex flex-col h-full min-h-0 bg-app-bg">
    <ScreenHeader title={title} onBack={onBack} backLabel={backLabel} className="px-4" />

    <div className="flex flex-col flex-1 min-h-0 px-6">
      <div className="flex-1 overflow-y-auto no-scrollbar pt-8">
        {date && <p className="text-sm text-heading-gray/50">{date}</p>}
        <p className="font-heading text-xl font-bold text-[#808080] mt-1">{title}</p>

        {hero}

        <div className="my-4 h-1.75 w-full rounded-full bg-primary-500" />

        <div className={classNames(dividers && 'divide-y divide-border-light')}>{children}</div>
      </div>

      <div className="shrink-0 pt-4 pb-24 flex flex-col gap-y-2">
        <Button
          type={primary.type ?? 'button'}
          title={primary.label}
          variant={ButtonVariant.Primary}
          onClick={primary.onPress}
          isLoading={primary.loading}
          disabled={primary.disabled || primary.loading}
          data-testid={primary['data-testid']}
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
        {secondary && (
          <Button
            type="button"
            title={secondary.label}
            variant={ButtonVariant.Secondary}
            onClick={secondary.onPress}
            disabled={secondary.disabled}
            className="w-full max-w-none rounded-full text-base font-semibold"
          />
        )}
      </div>
    </div>
  </div>
);
