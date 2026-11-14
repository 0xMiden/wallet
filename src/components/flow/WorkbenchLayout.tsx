import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { IconButton } from 'components/ui/IconButton';

export interface WorkbenchLayoutProps {
  title: React.ReactNode;
  composition?: React.ReactNode;
  summary?: React.ReactNode;
  footer?: React.ReactNode;
  onBack?: () => void;
  onMinimize?: () => void;
  children: React.ReactNode;
}

export function WorkbenchLayout({
  title,
  composition,
  summary,
  footer,
  onBack,
  onMinimize,
  children
}: WorkbenchLayoutProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl bg-page text-ink"
      data-testid="command-workbench"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
        {onBack && <IconButton icon={IconName.ArrowLeft} label={t('back')} onClick={onBack} />}
        <h1 className="min-w-0 flex-1 text-title-tab">{title}</h1>
        {onMinimize && <IconButton icon={IconName.Close} label={t('minimize')} onClick={onMinimize} />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {composition}
        {children}
        {summary && (
          <details className="mt-4 rounded-xl bg-fill p-4 text-body text-ink">
            <summary>{t('commandDetails')}</summary>
            {summary}
          </details>
        )}
      </div>
      {footer && <footer className="shrink-0 border-t border-hairline px-4 py-3">{footer}</footer>}
    </section>
  );
}
