import React, { FC, ReactNode } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

export interface TabHeaderProps {
  title: string;
  /** Extra action buttons rendered before the built-in settings button. */
  actions?: ReactNode;
}

/**
 * Header for top-level tab pages (Activity, Explore): page title on the
 * left, a settings button (plus any extra `actions`) on the right.
 */
export const TabHeader: FC<TabHeaderProps> = ({ title, actions }) => {
  const { t } = useTranslation();

  return (
    <header className="shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#00000017]">
      <h1 className="font-heading text-[28px] font-bold text-heading-gray dark:text-pure-white">{title}</h1>
      <div className="flex items-center gap-2">
        {actions}
        <button
          type="button"
          aria-label={t('settings')}
          onClick={() => {
            hapticLight();
            navigate('/settings');
          }}
          className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-25 text-text-primary-token"
        >
          <Icon name={IconName.Settings} className="w-4 h-4" fill="currentColor" />
        </button>
      </div>
    </header>
  );
};

export default TabHeader;
