import React from 'react';

import { SubPageLayout, SubPageLayoutProps } from 'components/ui/SubPageLayout';

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
  'data-testid': dataTestId
}) => (
  // No tab bar is ever drawn over onboarding, so the pinned CTA keeps the flat 16px margin.
  <SubPageLayout data-testid={dataTestId} footer={footer} footerLayout={footerLayout} footerNavbarCushion={false}>
    {(eyebrow || title || description || aside) && (
      <div data-slot="step-heading" className="flex shrink-0 flex-col items-start gap-2 pt-4">
        {eyebrow && <div className="pb-1">{eyebrow}</div>}
        {title && <h1 className="text-title-tab text-ink">{title}</h1>}
        {description && <div className="text-explainer text-muted">{description}</div>}
        {aside}
      </div>
    )}
    {children}
  </SubPageLayout>
);

export default OnboardingStepLayout;
