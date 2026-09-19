import React, { useEffect, useRef } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
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
 * The header of every pushed page: back, title, actions and close in one 52px row, like a native
 * navigation bar. Tab roots use TabHeader and sheets DrawerHeader; everything else uses this, so a
 * page's content starts at the same height everywhere. No horizontal padding: it takes the page's.
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
    <header className={clsx('flex h-13 shrink-0 items-center gap-3', className)}>
      {onBack && (
        // `bare` is always `ink`, in a flow too: the flow accents are under 3:1 on white.
        <IconButton icon={IconName.ChevronLeft} label={t('back')} onClick={onBack} data-testid={backTestId} />
      )}
      {title ? (
        <h1
          ref={titleRef}
          tabIndex={focusTitleOnMount ? -1 : undefined}
          // Clamped, not truncated: a long German title keeps its second line instead of an ellipsis.
          className="line-clamp-2 min-w-0 flex-1 font-heading text-xl leading-tight font-extrabold break-words text-ink outline-none"
        >
          {title}
        </h1>
      ) : (
        <span className="flex-1" />
      )}
      {actions}
      {onClose && <IconButton icon={IconName.Close} label={t('close')} onClick={onClose} data-testid={closeTestId} />}
    </header>
  );
};
