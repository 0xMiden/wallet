import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import { SearchInput } from './SearchInput';

export interface TabHeaderProps {
  title: string;
  /** Extra action buttons rendered before the built-in settings button. */
  actions?: ReactNode;
  /** Leave out the settings button. The page supplies its own `actions`. */
  hideSettings?: boolean;
  /**
   * In-header search. While `open`, the field takes the title's place in the
   * same row, so the page below keeps its position.
   */
  search?: {
    open: boolean;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
  };
}

/** Round icon button for the header's action group. */
export const TabHeaderAction: FC<{ label: string; icon: IconName; active?: boolean; onClick: () => void }> = ({
  label,
  icon,
  active = false,
  onClick
}) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={active}
    onClick={() => {
      hapticLight();
      onClick();
    }}
    className={classNames(
      'flex items-center justify-center w-9 h-9 rounded-full',
      active ? 'bg-accent-primary text-pure-white' : 'bg-gray-25 text-text-primary-token'
    )}
  >
    <Icon name={icon} className="w-4 h-4" fill="currentColor" />
  </button>
);

/**
 * Header for top-level tab pages (Activity, Explore): page title on the
 * left, a settings button (plus any extra `actions`) on the right.
 */
export const TabHeader: FC<TabHeaderProps> = ({ title, actions, hideSettings = false, search }) => {
  const { t } = useTranslation();
  const searchOpen = search?.open === true;

  return (
    <>
      <header className="shrink-0 px-4 py-3 flex h-15 items-center justify-between gap-3">
        {searchOpen && search ? (
          <SearchInput
            size="sm"
            className="min-w-0 flex-1"
            value={search.value}
            onChange={search.onChange}
            placeholder={search.placeholder}
            autoFocus
          />
        ) : (
          <h1 className="min-w-0 truncate font-heading text-[28px] font-bold leading-9 text-heading-gray dark:text-pure-white">
            {title}
          </h1>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {!hideSettings && (
            <TabHeaderAction label={t('settings')} icon={IconName.Settings} onClick={() => navigate('/settings')} />
          )}
        </div>
      </header>
      <div aria-hidden="true" className="shrink-0 mx-4 h-1 rounded-full bg-gray-50" />
    </>
  );
};

export default TabHeader;
