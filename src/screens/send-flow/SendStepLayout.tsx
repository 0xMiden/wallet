import React, { useRef } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { useNavbarHidden } from 'lib/mobile/useNavbarHidden';

import { stepFooterCushionClass } from './footer-cushion';
import { useSlideOnReflow } from './useSlideOnReflow';

export interface SendStepLayoutProps {
  /** Step title, e.g. "Choose recipient". */
  title: React.ReactNode;
  /** Right side of the title row, e.g. a network chip. */
  titleAccessory?: React.ReactNode;
  /** Back button in the top row. The row keeps its height without one, so titles line up across steps. */
  onBack?: () => void;
  children: React.ReactNode;
  /** The step's primary CTA. */
  footer: React.ReactNode;
}

/**
 * The frame every send step shares, so moving between steps changes only the
 * content: the back row, the title and the first line of the step's large input
 * sit at the same position on each one, and the CTA is pinned to the bottom. Highlights use the Send
 * accent; only the primary CTA keeps the brand orange.
 */
export const SendStepLayout: React.FC<SendStepLayoutProps> = ({ title, titleAccessory, onBack, children, footer }) => {
  const { t } = useTranslation();
  // With the tab bar hidden (steps past the recipient, or the keyboard up) the
  // CTA sits at the bottom of the screen; with it showing, just above it.
  const navbarHidden = useNavbarHidden();
  // The keyboard and the tab bar move the CTA by snapping layout; slide it there instead.
  const rootRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  useSlideOnReflow(footerRef, rootRef);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-app-bg px-6">
      <div className="flex h-12 shrink-0 items-end">
        {onBack && (
          <button
            type="button"
            onClick={() => {
              hapticLight();
              onBack();
            }}
            aria-label={t('back')}
            data-testid="send-step-back"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-nav-button"
          >
            <Icon name={IconName.BackArrow} size="sm" fill="currentColor" className="text-accent-send" />
          </button>
        )}
      </div>

      <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto pt-4">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <h1 className="font-heading text-2xl leading-none font-black text-gray">{title}</h1>
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
