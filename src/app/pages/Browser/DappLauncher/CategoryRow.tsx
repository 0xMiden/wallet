/**
 * Horizontal chip row for filtering the launcher by category.
 *
 * Tapping a chip toggles the active filter (tap again to clear). The
 * `<MyDappsGrid>` reads the active category from `<DappLauncher>` state.
 * The chip layout is centered if there are 4 categories (default), but
 * the row scrolls horizontally if more are added later.
 */

import React, { type FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon } from 'app/icons/v2';
import { CATEGORIES, type FeaturedDappCategory } from 'lib/dapp-browser';
import { hapticSelection } from 'lib/mobile/haptics';

interface CategoryRowProps {
  active: FeaturedDappCategory | null;
  onToggle: (next: FeaturedDappCategory | null) => void;
}

export const CategoryRow: FC<CategoryRowProps> = ({ active, onToggle }) => {
  const { t } = useTranslation();

  return (
    <div className="px-4">
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map(cat => {
          const isActive = active === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                hapticSelection();
                onToggle(isActive ? null : cat.id);
              }}
              className={classNames(
                'flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary-500 text-pure-white shadow-[0_2px_6px_rgba(255,87,0,0.3)]'
                  : 'bg-grey-100 text-grey-700 active:bg-grey-200'
              )}
              aria-pressed={isActive}
            >
              <Icon name={cat.icon} size="xs" className={isActive ? 'text-pure-white' : 'text-grey-500'} />
              <span>{t(cat.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
