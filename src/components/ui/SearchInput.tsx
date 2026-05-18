import React, { FC, ChangeEvent } from 'react';

import classNames from 'clsx';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

export const SearchInput: FC<SearchInputProps> = ({ value, onChange, placeholder = 'Search', className, autoFocus }) => {
  const hasValue = value.length > 0;

  return (
    <div className={classNames('w-full bg-gray-25 rounded-md-token', className)}>
      <input
        type="text"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={classNames(
          'w-full bg-transparent outline-none px-4 py-3.5 text-sm',
          'placeholder:text-text-tertiary-token placeholder:font-normal',
          hasValue ? 'text-accent-primary font-semibold' : 'text-text-tertiary-token font-normal'
        )}
      />
    </div>
  );
};

export default SearchInput;
