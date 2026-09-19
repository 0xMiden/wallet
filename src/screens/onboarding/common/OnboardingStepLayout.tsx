import React from 'react';

import { SubPageLayout, SubPageLayoutProps } from 'components/ui/SubPageLayout';

export interface OnboardingStepLayoutProps {
  /** Above the title: a tag such as the network's chip. */
  eyebrow?: React.ReactNode;
  /** The step's title: 28px Nunito 800, left, the step's one `h1`. */
  title?: React.ReactNode;
  /** 15px `muted` line under the title. */
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
 * opening on the step's 28px title and its `muted` subtitle; and the step's CTA pinned under the
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
  <SubPageLayout data-testid={dataTestId} footer={footer} footerLayout={footerLayout}>
    {(eyebrow || title || description || aside) && (
      <div data-slot="step-heading" className="flex flex-col items-start gap-2 pt-4">
        {eyebrow && <div className="pb-1">{eyebrow}</div>}
        {title && (
          <h1 className="font-heading text-[28px] leading-9 font-extrabold tracking-[-0.5px] text-ink">{title}</h1>
        )}
        {description && <div className="font-sans text-[15px] leading-[22px] text-muted">{description}</div>}
        {aside}
      </div>
    )}
    {children}
  </SubPageLayout>
);

export default OnboardingStepLayout;
