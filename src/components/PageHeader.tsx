import React, { useEffect, useRef } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { HeaderRule } from 'components/ui/HeaderRule';
import { IconButton } from 'components/ui/IconButton';

export interface PageHeaderProps {
  /** Omit when the page's body owns its heading, so there is never an empty `<h1>`. */
  title?: React.ReactNode;
  /** Back button, left. */
  onBack?: () => void;
  /** Close button, right. */
  onClose?: () => void;
  /** Right side before Close, e.g. an Edit pill or a network chip. */
  actions?: React.ReactNode;
  /**
   * Move focus to the title on mount. A route change is not announced, and the control that
   * triggered it unmounts with its page, so without this the new page is never named.
   */
  focusTitleOnMount?: boolean;
  backTestId?: string;
  closeTestId?: string;
  className?: string;
}

/**
 * The header of every pushed page: back, title, actions and close in one row of at least 60px, like
 * a native navigation bar, then the 4px rule under it. The row grows for a title that takes its
 * second line, so the rule is never drawn across it. Tab roots use TabHeader and sheets
 * DrawerHeader; everything else uses this, so a page's content starts at the same height wherever
 * its title fits one line. No
 * horizontal padding of its own: `className` lands on the block holding both the row and the rule,
 * so the page margin a caller passes insets them together.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  onBack,
  onClose,
  actions,
  focusTitleOnMount = false,
  backTestId = 'page-back',
  closeTestId = 'page-close',
  className
}) => {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusTitleOnMount) titleRef.current?.focus();
  }, [focusTitleOnMount]);

  return (
    <div className={clsx('flex shrink-0 flex-col', className)}>
      <header className="flex min-h-15 shrink-0 items-center gap-3">
        {onBack && (
          // A 44px `fill` circle with an `ink` glyph, in a flow too: the flow accents are under 3:1 on white.
          <IconButton
            icon={IconName.ArrowLeft}
            appearance="filled"
            label={t('back')}
            onClick={onBack}
            data-testid={backTestId}
          />
        )}
        {title ? (
          <h1
            ref={titleRef}
            tabIndex={focusTitleOnMount ? -1 : undefined}
            // Clamped, not truncated: a long German title keeps its second line instead of an ellipsis.
            className="line-clamp-2 min-w-0 flex-1 text-title-tab break-words text-ink outline-none"
          >
            {title}
          </h1>
        ) : (
          <span className="flex-1" />
        )}
        {actions}
        {onClose && <IconButton icon={IconName.Close} label={t('close')} onClick={onClose} data-testid={closeTestId} />}
      </header>
      {/*
        The 8px under the rule is the header's, not the page's: it is the same rule `TabRootHeader`
        draws and the same `mb-2` it puts under it, so the first line of content sits at one
        height whether the page is a tab root or pushed. Every page that used to set its own
        `pt-*` here started its body somewhere else (2, 3, 4, 6 and 8 all shipped), which is
        what made the encrypted-wallet-file page's first label sit against the rule while its
        siblings had air. A caller adds no top padding of its own.
      */}
      <HeaderRule className="mb-2" />
    </div>
  );
};
