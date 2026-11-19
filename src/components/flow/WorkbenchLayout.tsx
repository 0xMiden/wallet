import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { IconButton } from 'components/ui/IconButton';

export interface WorkbenchLayoutProps {
  title: React.ReactNode;
  composition?: React.ReactNode;
  summary?: React.ReactNode;
  footer?: React.ReactNode;
  summaryOutlet?: (node: HTMLDivElement | null) => void;
  footerOutlet?: (node: HTMLElement | null) => void;
  onBack?: () => void;
  onMinimize?: () => void;
  children: React.ReactNode;
}

export function WorkbenchLayout({
  title,
  composition,
  summary,
  footer,
  summaryOutlet,
  footerOutlet,
  onBack,
  onMinimize,
  children
}: WorkbenchLayoutProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[1.625rem] border border-accent-tint-ink/30 border-t-accent-tint-ink/55 bg-page bg-linear-to-br from-fill via-page to-fill/70 text-ink shadow-2xl ring-1 ring-inset ring-ink/5"
      data-testid="command-workbench"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline bg-fill/40 px-4 py-3 sm:px-7 sm:py-5">
        {onBack && <IconButton icon={IconName.ArrowLeft} label={t('back')} onClick={onBack} />}
        <h1 className="min-w-0 flex-1 text-title-tab">{title}</h1>
        {onMinimize && <IconButton icon={IconName.Close} label={t('minimize')} onClick={onMinimize} />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-7 sm:py-6">
        {composition}
        {children}
        {(summary || summaryOutlet) && (
          <details className="mt-5 border-t border-hairline pt-3 text-body-sm text-ink" data-testid="command-details">
            <summary className="min-h-10 cursor-pointer py-2 text-muted">{t('commandDetails')}</summary>
            <div ref={summaryOutlet} className="pt-2">
              {summary}
            </div>
          </details>
        )}
      </div>
      {(footer || footerOutlet) && (
        <footer
          ref={footerOutlet}
          data-command-footer={footerOutlet ? 'true' : undefined}
          data-testid="command-footer"
          className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-hairline bg-fill/40 px-4 py-3 sm:px-7 sm:py-4"
        >
          {footer}
        </footer>
      )}
    </section>
  );
}
