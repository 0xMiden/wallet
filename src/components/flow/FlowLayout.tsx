import React, { useRef } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { NavButton } from 'components/NavButton';
import { useNavbarHidden } from 'lib/mobile/useNavbarHidden';

import { ACCENT_CLASSES, FlowAccent } from './accent';
import { stepFooterCushionClass } from './footer-cushion';
import { useSlideOnReflow } from './useSlideOnReflow';

export interface FlowLayoutProps {
  /** Page title, e.g. "Choose recipient", "Review details", "Processing". */
  title: React.ReactNode;
  /** Right side of the title row, e.g. a network chip. */
  titleAccessory?: React.ReactNode;
  /** Back button, top left. */
  onBack?: () => void;
  /** Close button, top right. */
  onClose?: () => void;
  accent?: FlowAccent;
  /** Focus target for the title, for screens that replace another in place. */
  titleRef?: React.Ref<HTMLHeadingElement>;
  children: React.ReactNode;
  /** The page's CTAs, pinned to the bottom. */
  footer: React.ReactNode;
}

/**
 * The frame every page of a flow shares (send steps, review, processing, the receipt), so moving
 * through a flow changes only the content: the top row, the title, the start of the content and the
 * CTA sit at the same position on each page. The top row keeps its height with no button in it.
 */
export const FlowLayout: React.FC<FlowLayoutProps> = ({
  title,
  titleAccessory,
  onBack,
  onClose,
  accent = 'brand',
  titleRef,
  children,
  footer
}) => {
  const { t } = useTranslation();
  // With the tab bar hidden (steps past the recipient, full-screen pages, or the keyboard up) the
  // CTA sits at the bottom of the screen; with it showing, just above it.
  const navbarHidden = useNavbarHidden();
  // The keyboard and the tab bar move the CTA by snapping layout; slide it there instead.
  const rootRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  useSlideOnReflow(footerRef, rootRef);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-1 flex-col bg-app-bg px-6">
      <div className="flex h-12 shrink-0 items-end justify-between">
        {onBack ? (
          <NavButton
            icon={IconName.BackArrow}
            label={t('back')}
            onClick={onBack}
            iconClassName={ACCENT_CLASSES[accent].text}
            data-testid="flow-back"
          />
        ) : (
          <span />
        )}
        {onClose && <NavButton icon={IconName.Close} label={t('close')} onClick={onClose} data-testid="flow-close" />}
      </div>

      <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto pt-4">
        <div className="flex min-h-6 shrink-0 items-center justify-between gap-3">
          <h1
            ref={titleRef}
            tabIndex={titleRef ? -1 : undefined}
            className="font-heading text-2xl leading-none font-black text-gray outline-none"
          >
            {title}
          </h1>
          {titleAccessory}
        </div>
        {children}
      </div>

      <div ref={footerRef} className={clsx('shrink-0 pt-3', navbarHidden ? 'pb-4' : stepFooterCushionClass())}>
        {footer}
      </div>
    </div>
  );
};
