import React, { FC, ChangeEvent, KeyboardEvent, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

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
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const showClear = value.length > 0;

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  const handleClear = () => {
    hapticLight();
    onChange('');
  };

  return (
    <div className={classNames('relative w-full bg-gray-25 rounded-3xl h-14', className)}>
      <input
        type="text"
        data-testid={dataTestId}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={onSubmit ? handleKeyDown : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // Hide the placeholder while focused so it can't be mistaken for typed text (#503).
        placeholder={focused ? undefined : placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        inputMode={inputMode}
        enterKeyHint={onSubmit ? (inputMode === 'url' ? 'go' : 'search') : 'done'}
        autoCapitalize={inputMode === 'url' ? 'none' : undefined}
        autoCorrect={inputMode === 'url' ? 'off' : undefined}
        spellCheck={inputMode === 'url' ? false : undefined}
        className={classNames(
          'w-full h-full bg-transparent outline-none text-base font-heading text-center',
          // Placeholder stays lighter/regular so it never matches the typed-value weight (#503).
          'placeholder:text-text-muted placeholder:font-medium placeholder:text-center',
          'text-black font-bold',
          showClear ? 'pl-4 pr-12' : 'px-4'
        )}
      />
      {showClear && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={handleClear}
          aria-label={t('clearSearch')}
          data-testid={dataTestId ? `${dataTestId}-clear` : 'search-input-clear'}
          className="absolute right-3 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-heading-gray"
        >
          <Icon name={IconName.Close} size="xs" fill="currentColor" className="text-heading-gray" />
        </button>
      )}
    </div>
  );
};

export default SearchInput;
