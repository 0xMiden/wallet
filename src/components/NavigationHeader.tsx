import React, { HTMLAttributes, useEffect, useRef } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';

import { CircleButton } from './CircleButton';

export interface NavigationHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Optional, because a screen whose body owns the page heading must not get a
   * second one here — the Guardian picker renders its own h1 plus a description
   * and an info button. Omitting it renders no heading at all rather than an
   * empty one; see the render below.
   */
  title?: string;
  mode?: 'back' | 'close';
  onBack?: () => void;
  onClose?: () => void;
  showBorder?: boolean;
  innerDivClassName?: string;
  /** 'prominent' uses the tab-header title weight and a rounded divider bar below. */
  variant?: 'default' | 'prominent';
  /** Title placement; 'left' sits the title next to the back button. */
  titleAlign?: 'center' | 'left';
  /**
   * Move keyboard/screen-reader focus to the title on mount. For screens reached
   * by an in-app route change, which browsers and Woozie do not announce: the
   * trigger unmounts with the page it was on, so focus falls to `<body>` and the
   * new screen is never named.
   */
  focusTitleOnMount?: boolean;
}

export const NavigationHeader: React.FC<NavigationHeaderProps> = ({
  className,
  onBack,
  onClose,
  showBorder = false,
  innerDivClassName,
  variant = 'default',
  titleAlign = 'center',
  focusTitleOnMount = false,
  ...props
}) => {
  const { t } = useTranslation();
  const prominent = variant === 'prominent';
  const centered = titleAlign === 'center';
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusTitleOnMount) titleRef.current?.focus();
  }, [focusTitleOnMount]);
  return (
    <>
      <div
        className={classNames(
          'flex flex-row px-4 items-center w-full bg-app-bg',
          showBorder && 'border-b-[0.5px] border-border-card',
          'py-4',
          className
        )}
      >
        <div className={classNames('flex flex-row items-center gap-x-4 w-full text-xl text-black', innerDivClassName)}>
          {onBack ? (
            // currentColor on BOTH variants: CircleButton defaults its icon fill to
            // a literal `black`, invisible on the dark app background. The inner div
            // above carries `text-black`, which auto-flips, so the glyph follows the
            // theme. The default variant was left out of the original fix, which is
            // why the chevron vanished in dark mode on token detail and the seed
            // phrase screens.
            // 44px (`w-11`), not 40: this is the sole back affordance on every
            // screen the routed-page conversion touched — those pass `hideToolbar`
            // to PageLayout, so there is no toolbar handler behind it — and 40
            // misses both the 44pt iOS and 48dp Android minimums.
            <CircleButton
              aria-label={t('back')}
              icon={prominent ? IconName.ArrowLeft : IconName.ChevronLeft}
              onClick={onBack}
              className={classNames('shrink-0', prominent && 'w-11 h-11 bg-gray-25 text-black')}
              size="sm"
              color="currentColor"
            />
          ) : null}
          {/* No heading when there is no title, rather than an empty one — same
              shape as ScreenHeader. A caller passes no title when the screen it
              wraps owns the page heading itself (the Guardian picker renders its
              own h1 plus a description and an info button), and an `<h1></h1>`
              here announced a nameless level-1 heading above it. The spacer keeps
              a close button pinned right. */}
          {props.title ? (
            <h1
              ref={titleRef}
              // -1 so it is programmatically focusable without joining the tab
              // order, the standard shape for a route-change focus target.
              tabIndex={focusTitleOnMount ? -1 : undefined}
              className={classNames(
                // `min-w-0 break-words` because a flex item's automatic minimum
                // size is its min-content width, so an unbreakable word pushes
                // out of the row instead of wrapping — and PageLayout's content
                // is `overflow-hidden`, so the tail is cut with no ellipsis and
                // no way to scroll to it. At 28px bold there are only ~272px in
                // a 360px popup, which the longer German titles already crowd.
                'font-heading flex-1 min-w-0 break-words',
                centered ? 'text-center' : 'text-left',
                prominent ? 'text-[28px] font-bold text-heading-gray' : 'font-medium',
                onBack && centered ? 'pr-10' : ''
              )}
            >
              {props.title}
            </h1>
          ) : (
            <div className="flex-1" />
          )}
        </div>
        {onClose ? (
          // CircleButton defaults its icon fill to a literal `black`, which is
          // invisible against the dark app background; currentColor hands the
          // glyph to text-black instead, which auto-flips with the theme.
          <CircleButton
            aria-label={t('close')}
            icon={IconName.Close}
            onClick={onClose}
            className={classNames('shrink-0 text-black', prominent && 'w-11 h-11 bg-gray-25')}
            size={prominent ? 'sm' : undefined}
            color="currentColor"
          />
        ) : null}
      </div>
      {prominent && <div aria-hidden="true" className="shrink-0 mx-4 mb-4 h-1 rounded-full bg-gray-50" />}
    </>
  );
};
