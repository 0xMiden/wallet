import React from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Link } from 'lib/woozie';

type ImportTabDescriptor = {
  slug: string;
  i18nKey: string;
};

type ImportTabSwitcherProps = {
  className?: string;
  tabs: ImportTabDescriptor[];
  activeTabSlug: string;
  urlPrefix: string;
};

const ImportTabSwitcher: React.FC<ImportTabSwitcherProps> = ({ className, tabs, activeTabSlug, urlPrefix }) => {
  const { t } = useTranslation();

  return (
    <div className={classNames('w-full', className)} style={{ borderBottomWidth: 1, fontSize: 17 }}>
      <div className={classNames('flex items-center justify-around')}>
        {tabs.map(({ slug, i18nKey }) => {
          const active = slug === activeTabSlug;

          return (
            <Link key={slug} to={`${urlPrefix}/${slug}`} replace>
              <div
                className={classNames(
                  'text-center cursor-pointer pb-1 pt-2 px-4',
                  'text-text-muted',
                  'border-b-2',
                  active ? 'border-primary-orange' : 'border-transparent',
                  active ? 'text-primary-orange' : 'hover:text-primary-orange',
                  'transition-colors ease-hover duration-150',
                  'truncate'
                )}
              >
                {t(i18nKey)}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
};

export default ImportTabSwitcher;
