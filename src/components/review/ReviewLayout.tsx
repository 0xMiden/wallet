import React from 'react';

import classNames from 'clsx';

import { Button, ButtonVariant } from 'components/Button';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';

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
 * Shared shell for review/confirmation screens: hero → orange divider → detail
 * rows → primary/secondary CTAs, all in one scrolling column (the CTAs flow at
 * the end of the content, not a sticky footer). There is no screen header; back
 * is reached via the secondary CTA (or native mobile back). Flow-specific content
 * (hero, rows) and callbacks are passed in, so each flow keeps its own confirm
 * logic while sharing one consistent layout. `pb-24` clears the floating BottomNav.
 */
export const ReviewLayout: React.FC<ReviewLayoutProps> = ({ hero, dividers = true, children, primary, secondary }) => {
  // Hide the bottom tab navbar while this review screen is mounted (no-op on
  // full-screen routes that render outside TabLayout).
  useHideNavbarWhileOpen();

  return (
    <div className="flex flex-col h-full min-h-0 bg-app-bg px-4 pt-6 pb-4">
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        {hero}

        <div className="mt-4 h-2 w-full rounded-full bg-primary-500" />

        <div className={classNames(dividers && 'divide-y divide-[#F1F1F1]')}>{children}</div>
      </div>

      <div className="shrink-0 pt-6 flex flex-col gap-y-2">
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
  );
};
