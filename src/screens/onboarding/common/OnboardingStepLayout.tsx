import React from 'react';

import { SubPageLayout, SubPageLayoutProps } from 'components/ui/SubPageLayout';
import { cn } from 'lib/ui/util';

export interface OnboardingStepLayoutProps {
  /** Above the title: a tag such as the network's chip. */
  eyebrow?: React.ReactNode;
  /** The step's title: `text-title-tab`, left, the step's one `h1`. */
  title?: React.ReactNode;
  /** The `text-explainer` line under the title, in `muted`. */
  description?: React.ReactNode;
  /** Under the description: a text action such as "Learn more". */
  aside?: React.ReactNode;
  /** The step's content, 20px between blocks. */
  children?: React.ReactNode;
  /** The step's actions, pinned under the body: the primary CTA first. */
  footer?: React.ReactNode;
  /** `stack` (default) puts the footer's buttons one above the other; `row` splits the row. */
  footerLayout?: SubPageLayoutProps['footerLayout'];
  /** `hero`: the heading block centred, with the larger `text-hero-value` title (Meet your Guardian). */
  heading?: 'default' | 'hero';
  /** Extra inset for the heading and the body, on top of the 16px page margin: `px-6` for 24px sides. */
  inset?: string;
  'data-testid'?: string;
}

/**
 * The frame of every onboarding step, on `SubPageLayout`: the onboarding navigator owns the progress
 * indicator above it, so there is no page header; a body that scrolls with the 16px page margin,
 * opening on the step's `text-title-tab` title and its `text-explainer` line; and the step's CTA pinned under the
 * body, never scrolled away on a short screen.
 */
export const OnboardingStepLayout: React.FC<OnboardingStepLayoutProps> = ({
  eyebrow,
  title,
  description,
  aside,
  children,
  footer,
  footerLayout = 'stack',
  heading = 'default',
  inset,
  'data-testid': dataTestId
}) => (
  <SubPageLayout data-testid={dataTestId} footer={footer} footerLayout={footerLayout} bodyClassName={inset}>
    {(eyebrow || title || description || aside) && (
      <div
        data-slot="step-heading"
        className={cn(
          'flex shrink-0 flex-col gap-2 pt-4',
          heading === 'hero' ? 'items-center text-center' : 'items-start'
        )}
      >
        {eyebrow && <div className="pb-1">{eyebrow}</div>}
        {title && (
          <h1 className={cn(heading === 'hero' ? 'text-hero-value' : 'text-title-tab', 'text-ink')}>{title}</h1>
        )}
        {description && <div className="text-explainer text-muted">{description}</div>}
        {aside}
      </div>
    )}
    {children}
  </SubPageLayout>
);

export default OnboardingStepLayout;
