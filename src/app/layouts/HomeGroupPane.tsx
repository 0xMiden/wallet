import React from 'react';

import clsx from 'clsx';

import { FlowFooter } from 'components/flow/FlowFooter';
import { stepFooterCushionClass } from 'components/flow/footer-cushion';

/**
 * The one box every home-group pane is drawn in — Overview's four action panes (Send, Receive,
 * Earn, Swap) and every flow page inside them.
 *
 * The four panes used to root themselves four different ways (a flow frame at a 24px gutter, a
 * bare scroller with its own `touch-action`, a page that padded its own column), which is how they
 * drifted apart: their titles sat at three different heights, the Send pane was inset past the
 * others, and a horizontal scroller inside one of them took the carousel's swipe away. Everything
 * structural lives here now, so a pane differs from its neighbours only in what it puts inside.
 *
 * What this owns:
 *
 * - **Full bleed.** The root fills the carousel's pane edge to edge, on the app's own surface.
 * - **The horizontal gesture belongs to the carousel.** The body is `touch-action: pan-y` and
 *   `overflow-x: hidden`, so it can never become a horizontal scroll container itself and can
 *   never pan sideways. `HomeSwipeContainer` sets `touch-pan-y` on the track, but a nested element
 *   that scrolls horizontally is the gesture's handler and wins the walk up the ancestor chain —
 *   which is exactly how the Send pane lost its swipe. A pane that genuinely wants a sideways
 *   scroller (Earn's position row) opts in explicitly, with its own `touch-pan-x` and a
 *   `pointerdown` that does not reach the track.
 * - **The page margin**: 16px, the design system's, the same on all four, on the body and on the
 *   pinned CTA alike.
 * - **The top offset**: 24px from the top of the pane to its first line, so the title does not
 *   move as you swipe between panes.
 * - **Bottom clearance** over the docked tab bar, from the same expression the pinned CTA uses, so
 *   a pane without a CTA ends its content exactly where one with a CTA ends its button.
 */

/** The 16px page margin, on every pane and every flow page inside one. */
const PANE_GUTTER = 'px-4';

/**
 * Where the body's content starts.
 *
 * `root` is a pane's own first line, 24px down — Receive's "Receive at", Earn's "Your Earnings",
 * Send's "Send to", Swap's "You Pay". `header` is a pushed step: `PageHeader` already ends in its
 * own `mb-2` rule spacing, and that is the whole gap (`PushedPageGap.test.tsx` pins it against
 * `SubPageLayout`) — the body adds nothing on top of it, or a pushed flow step opens with 16px
 * instead of the 8px every other pushed page opens with.
 */
export type HomeGroupPaneTop = 'root' | 'header';

const PANE_TOP: Record<HomeGroupPaneTop, string> = {
  root: 'pt-6',
  header: ''
};

export interface HomeGroupPaneRootProps {
  /** The pane's own test id, kept on the outermost element where the e2e suites expect it. */
  testId?: string;
  children: React.ReactNode;
}

/**
 * The pane's outer box. Separate from the body because Send and Swap put a `Navigator` between the
 * two: their root holds the flow's drawers and stays mounted while the steps swap inside it.
 */
export const HomeGroupPaneRoot: React.FC<HomeGroupPaneRootProps> = ({ testId, children }) => (
  <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg" data-testid={testId}>
    {children}
  </div>
);

export interface HomeGroupPaneBodyProps {
  /** Test id for the scrolling body. */
  testId?: string;
  /** The pane's first line. Omitted where the content's own first line is the title (Swap). */
  title?: React.ReactNode;
  titleTestId?: string;
  /** Sits opposite the title on the same line: a chip, a text action. */
  titleAccessory?: React.ReactNode;
  top?: HomeGroupPaneTop;
  /** A pinned CTA under the body. Without one, the body itself clears the docked bar. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The scrolling body of a pane or of a flow page inside one: the gutter, the top offset, the
 * title line, the scroll and gesture contract, and the clearance over the docked tab bar.
 */
export const HomeGroupPaneBody: React.FC<HomeGroupPaneBodyProps> = ({
  testId,
  title,
  titleTestId,
  titleAccessory,
  top = 'root',
  footer,
  children
}) => (
  <>
    <div
      data-testid={testId}
      data-home-pane-body="true"
      // The vertical axis is the page's; the horizontal one is the carousel's. Declared here and
      // nowhere else, so no pane can quietly take the swipe back.
      style={{ touchAction: 'pan-y' }}
      className={clsx(
        'no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain',
        PANE_GUTTER,
        PANE_TOP[top],
        // With a footer the cushion is the footer's; without one it is the body's, from the same
        // expression, so both kinds of pane end the same distance above the bar.
        !footer && stepFooterCushionClass()
      )}
    >
      {title !== undefined && (
        <header className="flex shrink-0 items-start justify-between gap-3">
          <h1 data-testid={titleTestId} className="min-w-0 text-title-tab text-ink">
            {title}
          </h1>
          {titleAccessory && <div className="flex shrink-0 items-center gap-2">{titleAccessory}</div>}
        </header>
      )}
      {children}
    </div>

    {footer && <FlowFooter className={PANE_GUTTER}>{footer}</FlowFooter>}
  </>
);

export interface HomeGroupPaneProps extends HomeGroupPaneBodyProps {
  /** The pane's own test id, on the root. */
  paneTestId?: string;
}

/** Root and body together, for a pane with no `Navigator` between them (Receive, Earn). */
export const HomeGroupPane: React.FC<HomeGroupPaneProps> = ({ paneTestId, ...body }) => (
  <HomeGroupPaneRoot testId={paneTestId}>
    <HomeGroupPaneBody {...body} />
  </HomeGroupPaneRoot>
);
