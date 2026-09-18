import React, { useRef } from 'react';

import clsx from 'clsx';

import { PageHeader } from 'components/PageHeader';
import { useNavbarHidden } from 'lib/mobile/useNavbarHidden';

import { ACCENT_CLASSES, FlowAccent } from './accent';
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
  accent?: FlowAccent;
  /** Focus the title on mount, for screens that replace another in place. */
  focusTitleOnMount?: boolean;
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
  accent = 'brand',
  focusTitleOnMount,
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
      <PageHeader
        title={title}
        onBack={onBack}
        onClose={onClose}
        actions={titleAccessory}
        backIconClassName={ACCENT_CLASSES[accent].text}
        focusTitleOnMount={focusTitleOnMount}
        backTestId="flow-back"
        closeTestId="flow-close"
      />

      <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto pt-2">{children}</div>

      <div ref={footerRef} className={clsx('shrink-0 pt-3', navbarHidden ? 'pb-4' : stepFooterCushionClass())}>
        {footer}
      </div>
    </div>
  );
};
