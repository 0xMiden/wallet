import React, { useRef } from 'react';

import clsx from 'clsx';

import { PageHeader } from 'components/PageHeader';
import { useNavbarHidden } from 'lib/mobile/useNavbarHidden';

import { stepFooterCushionClass } from './footer-cushion';
import { useSlideOnReflow } from './useSlideOnReflow';

export interface FlowLayoutProps {
  /** Page title, e.g. "Choose recipient", "Review details", "Processing". */
  title: React.ReactNode;
  /** Right side of the header row, e.g. a network chip or an Edit pill. */
  titleAccessory?: React.ReactNode;
  /** Back button, top left. */
  onBack?: () => void;
  /** Close button, top right. */
  onClose?: () => void;
  /** Focus the title on mount, for screens that replace another in place. */
  focusTitleOnMount?: boolean;
  /**
   * The flow's first page is a tab root (Send's recipient step): its title is the tab's, drawn at
   * `text-title-tab` in the same 60px row as TabHeader's, not a pushed page's navigation bar.
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
 */
export const FlowLayout: React.FC<FlowLayoutProps> = ({
  title,
  titleAccessory,
  onBack,
  onClose,
  focusTitleOnMount,
  tabRoot = false,
  children,
  footer
}) => {
  // With the tab bar hidden (steps past the recipient, full-screen pages, or the keyboard up) the
  // CTA sits at the bottom of the screen; with it showing, just above it.
  const navbarHidden = useNavbarHidden();
  // The keyboard and the tab bar move the CTA by snapping layout; slide it there instead.
  const rootRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  useSlideOnReflow(footerRef, rootRef);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-1 flex-col bg-app-bg px-6">
      {!tabRoot && (
        <PageHeader
          title={title}
          onBack={onBack}
          onClose={onClose}
          actions={titleAccessory}
          focusTitleOnMount={focusTitleOnMount}
          backTestId="flow-back"
          closeTestId="flow-close"
        />
      )}

      {/* A tab root's title is not a navigation bar: it is the first line of the page, above the
          field it names, exactly where the swap page puts "You Pay". */}
      <div className={clsx('no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto', tabRoot ? 'pt-9' : 'pt-2')}>
        {tabRoot && (
          <header className="flex shrink-0 items-start justify-between gap-3">
            <h1 className="min-w-0 text-title-tab text-ink">{title}</h1>
            {titleAccessory && <div className="flex shrink-0 items-center gap-2">{titleAccessory}</div>}
          </header>
        )}
        {children}
      </div>

      <div ref={footerRef} className={clsx('shrink-0 pt-3', navbarHidden ? 'pb-4' : stepFooterCushionClass())}>
        {footer}
      </div>
    </div>
  );
};
