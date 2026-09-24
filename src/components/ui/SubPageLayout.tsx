import React, { createContext, useContext } from 'react';

import { PageHeader } from 'components/PageHeader';
import { SectionHeader } from 'components/ui/SectionHeader';
import { cn } from 'lib/ui/util';

/** What the header row shows: a routed page's title, its back handler and whether it takes focus. */
export interface SubPageHeaderConfig {
  title?: React.ReactNode;
  onBack?: () => void;
  /** Move focus to the title on mount, so the route change is announced. */
  focusTitleOnMount?: boolean;
}

const SubPageHeaderContext = createContext<SubPageHeaderConfig>({});

/**
 * Hands a sub-page its header from the route that opened it. Settings owns each sub-page's title,
 * back fallback and focus policy (they are properties of the tab, not of the page), so it provides
 * them here and every page renders the same `SubPageLayout` without repeating them.
 */
export const SubPageHeaderProvider: React.FC<{ value: SubPageHeaderConfig; children: React.ReactNode }> = ({
  value,
  children
}) => <SubPageHeaderContext.Provider value={value}>{children}</SubPageHeaderContext.Provider>;

export interface SubPageLayoutProps extends SubPageHeaderConfig {
  /** A close button at the header's right, for a page that is dismissed rather than popped. */
  onClose?: () => void;
  /** The page's sections, 20px apart. */
  children: React.ReactNode;
  /**
   * The page's actions, pinned under the body, 10px apart. Buttons here take `flex-1 max-w-none`
   * so a pair splits the row evenly and a single one spans it.
   */
  footer?: React.ReactNode;
  /** `stack` puts the footer's buttons one above the other, for labels too long to share a row. */
  footerLayout?: 'row' | 'stack';
  /** Layout only, on the scrolling body: an extra inset on top of the 16px page margin. */
  bodyClassName?: string;
  'data-testid'?: string;
}

/**
 * The frame of every pushed Settings page: the shared `PageHeader`, a body that scrolls under it
 * with the 16px page margin and 20px between sections, and an optional footer holding the page's
 * actions. Only the body scrolls; the header and the footer never do.
 *
 * The footer clears the bottom with the 16px page margin. On mobile the body element already pads
 * the page by the safe-area inset (and the keyboard), so the footer sits above the home indicator
 * without adding its own; these pages open in `FullScreenPage`, which has no tab bar to clear.
 *
 * Header props passed here win over the ones a `SubPageHeaderProvider` hands down, so a page that
 * owns its header (a multi-step flow) can set its own title and back per step.
 */
export const SubPageLayout: React.FC<SubPageLayoutProps> = ({
  children,
  footer,
  footerLayout = 'row',
  onClose,
  bodyClassName,
  'data-testid': dataTestId,
  ...header
}) => {
  const inherited = useContext(SubPageHeaderContext);
  const title = header.title ?? inherited.title;
  const onBack = header.onBack ?? inherited.onBack;
  const focusTitleOnMount = header.focusTitleOnMount ?? inherited.focusTitleOnMount;

  return (
    <div data-testid={dataTestId} className="flex min-h-0 flex-1 flex-col bg-app-bg">
      {(title !== undefined || onBack || onClose) && (
        <PageHeader
          className="px-4"
          title={title}
          onBack={onBack}
          onClose={onClose}
          focusTitleOnMount={focusTitleOnMount}
        />
      )}

      <div
        data-slot="body"
        className={cn('flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-2 pb-4', bodyClassName)}
      >
        {children}
      </div>

      {footer && (
        <div
          data-slot="footer"
          className={cn('flex shrink-0 gap-2.5 px-4 pt-3 pb-4', footerLayout === 'stack' && 'flex-col')}
        >
          {footer}
        </div>
      )}
    </div>
  );
};

export interface SubPageSectionProps {
  /** The section label, drawn as a `SectionHeader`. */
  title?: React.ReactNode;
  /** The label's heading level: `h2` under the page title, `h3` under a hero's own `h2`. */
  titleAs?: 'h2' | 'h3';
  /** A `muted` paragraph under the label, above the section's content (`text-body`). */
  description?: React.ReactNode;
  /** `muted` secondary copy under the content, such as what a toggle above it does (`text-body-sm`). */
  footnote?: React.ReactNode;
  children?: React.ReactNode;
  /** Layout only (margins). */
  className?: string;
  'data-testid'?: string;
}

/** Copy on a sub-page, inset 4px like the section label above it: a description is a paragraph
 * (`text-body`), a footnote under a control is secondary (`text-body-sm`), both `muted`. */
const noteClass = 'px-1 text-muted';

/**
 * One section of a sub-page: an optional label, optional explanatory copy, then its content (a
 * `ListGroup`, a `DetailCard`, a field or an action). Sections sit 20px apart in the layout body.
 */
export const SubPageSection: React.FC<SubPageSectionProps> = ({
  title,
  titleAs,
  description,
  footnote,
  children,
  className,
  'data-testid': dataTestId
}) => (
  <section data-testid={dataTestId} className={cn('flex flex-col', className)}>
    {title && <SectionHeader as={titleAs}>{title}</SectionHeader>}
    {description && <div className={cn(noteClass, 'text-body pb-3')}>{description}</div>}
    {children}
    {footnote && <div className={cn(noteClass, 'text-body-sm pt-2')}>{footnote}</div>}
  </section>
);
