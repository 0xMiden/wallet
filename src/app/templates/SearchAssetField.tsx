import React, { FC, InputHTMLAttributes } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import SearchField from 'app/templates/SearchField';

type SearchAssetFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  value: string;
  onValueChange: (v: string) => void;
};

const SearchAssetField: FC<SearchAssetFieldProps> = ({ className, ...rest }) => {
  const { t } = useTranslation();
  return (
    <SearchField
      className={classNames(
        'py-2 pl-8 pr-4',
        'bg-gray-100 focus:bg-transparent',
        'border border-transparent',
        'focus:outline-none focus:border-border-card',
        'transition ease-in-out duration-200',
        'rounded-md',
        'text-black text-sm leading-tight',
        'placeholder-alphagray',
        className
      )}
      placeholder={t('searchAssets')}
      searchIconClassName="h-5 w-auto"
      searchIconWrapperClassName="px-2 text-text-muted"
      {...rest}
    />
  );
};

export default SearchAssetField;
