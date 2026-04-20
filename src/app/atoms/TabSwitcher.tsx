import React from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { hapticSelection } from 'lib/mobile/haptics';
import { Link } from 'lib/woozie';

type TabDescriptor = {
  slug: string;
  i18nKey: string;
};

type TabSwitcherProps = {
  className?: string;
  tabs: TabDescriptor[];
  activeTabSlug: string;
  urlPrefix: string;
};

const TabSwitcher: React.FC<TabSwitcherProps> = ({ className, tabs, activeTabSlug, urlPrefix }) => {
  const { t } = useTranslation();

  return (
    <div
      className={classNames(
        'w-full max-w-sm mx-auto',
        'flex flex-wrap items-center justify-center p-1',
        'border border-gray-700 rounded-lg',
        className
      )}
    >
      {tabs.map(({ slug, i18nKey }) => {
        const active = slug === activeTabSlug;

        return (
          <Link
            key={slug}
            to={`${urlPrefix}/${slug}`}
            replace
            onClick={() => hapticSelection()}
            className={classNames(
              'text-center cursor-pointer rounded-lg py-3 px-3 mx-px',
              'text-black font-medium',
              active ? 'bg-gray-200' : 'hover:bg-gray-200 focus:bg-gray-700',
              'transition ease-in-out duration-200'
            )}
            style={{ width: `calc(${Math.floor(100 / tabs.length)}% - 2px)`, fontSize: '16px', lineHeight: '24px' }}
          >
            {t(i18nKey)}
          </Link>
        );
      })}
    </div>
  );
};

export default TabSwitcher;
