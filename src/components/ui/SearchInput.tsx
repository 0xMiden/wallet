import React, { FC, ChangeEvent } from 'react';

import classNames from 'clsx';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

export const SearchInput: FC<SearchInputProps> = ({
  value,
  onChange,
  placeholder = 'Search',
  className,
  autoFocus
}) => {
  const hasValue = value.length > 0;

  return (
    <div className={classNames('w-full bg-gray-25 rounded-3xl h-14', className)}>
      <input
        type="text"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={classNames(
          'w-full bg-transparent outline-none px-4 py-4 text-base font-heading',
          'placeholder:text-[#00000047] placeholder:font-bold',
          hasValue ? 'text-primary font-semibold' : 'text-text-tertiary-token font-normal'
        )}
      />
    </div>
  );
};

export default SearchInput;
