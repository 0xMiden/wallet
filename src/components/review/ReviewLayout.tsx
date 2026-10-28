import React from 'react';

import classNames from 'clsx';

import { Button, ButtonVariant } from 'components/Button';
import { FlowAccent } from 'components/flow/accent';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error';

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
  /** Identifies the displayed error for reporting; null marks a display that is not an error. */
  errorId?: UserErrorId | null;
  /** Hero block — a `Hero` amount (bridge deposit) or a composed swap hero. */
  hero: React.ReactNode;
  /** The flow this review belongs to; colours the primary CTA. Defaults to the brand orange. */
  accent?: FlowAccent;
  /** Divider lines around the children. Default true; a caller whose rows already live in one `DetailCard` (its own hairlines) passes false. */
  dividers?: boolean;
  /** The row content — a `DetailCard` of `DetailRow`s. */
  children: React.ReactNode;
  primary: ReviewAction;
  secondary?: ReviewAction;
  /** Optional message shown just above the CTAs — e.g. a failed bridge submit. */
  error?: React.ReactNode;
  /** Advisory content shown directly above the action buttons. */
  beforeActions?: React.ReactNode;
}

/**
 * Shared shell for review/confirmation screens: hero → detail
 * rows → primary/secondary CTAs, all in one scrolling column (the CTAs flow at
 * the end of the content, not a sticky footer). There is no screen header; back
 * is reached via the secondary CTA (or native mobile back). Flow-specific content
 * (hero, rows) and callbacks are passed in, so each flow keeps its own confirm
 * logic while sharing one consistent layout.
 */
export const ReviewLayout: React.FC<ReviewLayoutProps> = ({
  hero,
  accent = 'brand',
  dividers = true,
  children,
  primary,
  secondary,
  error,
  errorId,
  beforeActions
}) => {
  useUserVisibleError(error ? errorId : null, 'review');
  // Hide the bottom tab navbar while this review screen is mounted (no-op on
  // full-screen routes that render outside TabLayout).
  useHideNavbarWhileOpen();

  return (
    <div className="flex flex-col h-full min-h-0 bg-app-bg pb-[calc(1rem+var(--wallet-control-safe-bottom,0px))]">
      <NetworkModeBanner />
      <div className="flex flex-1 min-h-0 flex-col px-4 pt-6">
        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
          <div className="tx-stage-rise">{hero}</div>

          <div className={classNames('tx-stage-list', dividers && 'divide-y divide-rule-default')}>{children}</div>
        </div>

        <div className="shrink-0 pt-6 flex flex-col gap-y-2">
          {error && <p className="text-center text-sm text-red-500">{error}</p>}
          {beforeActions}
          <div className="tx-stage-cta">
            <Button
              type={primary.type ?? 'button'}
              title={primary.label}
              variant={ButtonVariant.Primary}
              accent={accent}
              onClick={primary.onPress}
              isLoading={primary.loading}
              disabled={primary.disabled || primary.loading}
              data-testid={primary['data-testid']}
              className="w-full max-w-none"
            />
          </div>
          {secondary && (
            <Button
              type="button"
              title={secondary.label}
              variant={ButtonVariant.Secondary}
              onClick={secondary.onPress}
              disabled={secondary.disabled}
              className="w-full max-w-none"
            />
          )}
        </div>
      </div>
    </div>
  );
};
