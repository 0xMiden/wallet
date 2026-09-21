import React from 'react';

import classNames from 'clsx';

import { Button, ButtonVariant } from 'components/Button';
import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';

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
  /** Hero block — a `Hero` amount (bridge deposit) or a composed swap hero. */
  hero: React.ReactNode;
  /** Accent underline under the hero. Default true; every current caller passes false (kept for a future hero that wants the accent divider back). */
  heroDivider?: boolean;
  /** The flow this review belongs to; colours the divider and the primary CTA. Defaults to the brand orange. */
  accent?: FlowAccent;
  /** Divider lines around the children. Default true; a caller whose rows already live in one `DetailCard` (its own hairlines) passes false. */
  dividers?: boolean;
  /** The row content — a `DetailCard` of `DetailRow`s. */
  children: React.ReactNode;
  primary: ReviewAction;
  secondary?: ReviewAction;
  /** Optional message shown just above the CTAs — e.g. a failed bridge submit. */
  error?: React.ReactNode;
}

/**
 * Shared shell for review/confirmation screens: hero → accent divider → detail
 * rows → primary/secondary CTAs, all in one scrolling column (the CTAs flow at
 * the end of the content, not a sticky footer). There is no screen header; back
 * is reached via the secondary CTA (or native mobile back). Flow-specific content
 * (hero, rows) and callbacks are passed in, so each flow keeps its own confirm
 * logic while sharing one consistent layout. `pb-24` clears the floating BottomNav.
 *
 * The screen it is drawn on decides whether the app's bars are up, not this layout: a routed
 * review (the EVM bridge deposit) is a `FullScreenPage`, and a review pushed inside a home pane
 * (the swap) is declared a sub-page by the flow that pushed it, gated on that pane's own path
 * (`useHomePaneSubPage`). Raising the navbar flag from here instead was ungated, and the swap pane
 * stays mounted: a swap left on its review went on hiding the tab bar — and locking the carousel's
 * horizontal swipe with it (#481) — while the user was looking at another pane entirely.
 */
export const ReviewLayout: React.FC<ReviewLayoutProps> = ({
  hero,
  heroDivider = true,
  accent = 'brand',
  dividers = true,
  children,
  primary,
  secondary,
  error
}) => {
  return (
    <div className="flex flex-col h-full min-h-0 bg-app-bg px-4 pt-6 pb-4">
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        {hero}

        {heroDivider && <div className={classNames('mt-4 h-2 w-full rounded-full', ACCENT_CLASSES[accent].bg)} />}

        <div className={classNames(dividers && 'divide-y divide-rule-default')}>{children}</div>
      </div>

      <div className="shrink-0 pt-6 flex flex-col gap-y-2">
        {error && <p className="text-center text-sm text-red-500">{error}</p>}
        <Button
          type={primary.type ?? 'button'}
          title={primary.label}
          variant={ButtonVariant.Primary}
          accent={accent}
          onClick={primary.onPress}
          isLoading={primary.loading}
          disabled={primary.disabled || primary.loading}
          data-testid={primary['data-testid']}
          className="w-full"
        />
        {secondary && (
          <Button
            type="button"
            title={secondary.label}
            variant={ButtonVariant.Secondary}
            onClick={secondary.onPress}
            disabled={secondary.disabled}
            className="w-full"
          />
        )}
      </div>
    </div>
  );
};
