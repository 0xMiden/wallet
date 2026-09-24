import React from 'react';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { PageHeader } from 'components/PageHeader';

export interface FlowLayoutProps {
  /** Page title, e.g. "Choose recipient", "Review details", "Processing". */
  title: React.ReactNode;
  /** Back button, top left. */
  onBack?: () => void;
  /** Close button, top right. */
  onClose?: () => void;
  /** Focus the title on mount, for screens that replace another in place. */
  focusTitleOnMount?: boolean;
  /**
   * The flow's first page is a tab root (Send's recipient step): its title is the tab's, drawn at
   * `text-title-tab` in the same 60px row as TabHeader's, not a pushed page's navigation bar.
   * It says nothing about the CTA's cushion: every flow page clears the docked bar while the bar
   * is up, because a pushed step inside TabLayout still has it drawn over the page (FlowFooter).
   */
  tabRoot?: boolean;
  children: React.ReactNode;
  /** The page's CTAs, pinned to the bottom. */
  footer: React.ReactNode;
}

/**
 * The frame every page of a flow shares (send steps, review, processing, the receipt), so moving
 * through a flow changes only the content: the header (the shared PageHeader), the start of the
 * content and the CTA sit at the same position on each page.
 *
 * The body is `HomeGroupPaneBody`, the same box Receive and Earn are drawn in — a flow that starts
 * as a home-carousel pane (Send, Swap) keeps one frame from its tab root through its pushed steps
 * to its receipt, at the one 16px page margin, and never takes the carousel's horizontal swipe.
 */
export const FlowLayout: React.FC<FlowLayoutProps> = ({
  title,
  onBack,
  onClose,
  focusTitleOnMount,
  tabRoot = false,
  children,
  footer
}) => {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-app-bg">
      {!tabRoot && (
        // `PageHeader` carries no horizontal padding of its own — it takes the page's — and its
        // inset rule is a sibling of the row, so both sit in one wrapper at the page margin.
        <div className="shrink-0 px-4">
          <PageHeader
            title={title}
            onBack={onBack}
            onClose={onClose}
            focusTitleOnMount={focusTitleOnMount}
            backTestId="flow-back"
            closeTestId="flow-close"
          />
        </div>
      )}

      {/* A tab root's title is not a navigation bar: it is the first line of the page, above the
          field it names, exactly where the swap page puts "You Pay" - so the pane shell draws it,
          at the one offset every home-group pane's first line sits at. */}
      <HomeGroupPaneBody title={tabRoot ? title : undefined} top={tabRoot ? 'root' : 'header'} footer={footer}>
        {children}
      </HomeGroupPaneBody>
    </div>
  );
};
