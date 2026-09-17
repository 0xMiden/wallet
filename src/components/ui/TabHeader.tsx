import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

import { SearchInput } from './SearchInput';

export interface TabHeaderProps {
  title: string;
  /** Extra action buttons rendered on the right of the title. */
  actions?: ReactNode;
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
 * left, any `actions` on the right.
 *
 * The settings gear that used to live here is gone — Settings is a primary
 * bottom-nav destination now, so a gear on the very screens that show that
 * tab was a duplicate affordance.
 */
export const TabHeader: FC<TabHeaderProps> = ({ title, actions, search }) => {
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
          <h1 className="min-w-0 truncate font-heading text-[28px] font-extrabold leading-9 tracking-[-0.5px] text-heading-gray dark:text-pure-white">
            {title}
          </h1>
        )}
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div aria-hidden="true" className="shrink-0 mx-4 h-1 rounded-full bg-gray-50" />
    </>
  );
};

export default TabHeader;
