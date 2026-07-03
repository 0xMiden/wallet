import React, { FC, ChangeEvent, KeyboardEvent } from 'react';

import classNames from 'clsx';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Fired when the user presses Enter (or the mobile keyboard's go/return key). */
  onSubmit?: () => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Set to `'url'` for URL entry — also disables autocapitalize/autocorrect. */
  inputMode?: 'text' | 'url' | 'search';
  'data-testid'?: string;
}

export const SearchInput: FC<SearchInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder = 'Search',
  className,
  autoFocus,
  inputMode,
  'data-testid': dataTestId
}) => {
  const hasValue = value.length > 0;

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={classNames('w-full bg-gray-25 rounded-3xl h-14', className)}>
      <input
        type="text"
        data-testid={dataTestId}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={onSubmit ? handleKeyDown : undefined}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        inputMode={inputMode}
        autoCapitalize={inputMode === 'url' ? 'none' : undefined}
        autoCorrect={inputMode === 'url' ? 'off' : undefined}
        spellCheck={inputMode === 'url' ? false : undefined}
        className={classNames(
          'w-full bg-transparent outline-none px-4 py-4 text-base font-heading',
          'placeholder:text-[#00000047] placeholder:font-bold placeholder:text-center',
          hasValue ? 'text-primary font-semibold' : 'text-text-tertiary-token font-normal'
        )}
      />
    </div>
  );
};

export default SearchInput;
