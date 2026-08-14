import React, { FC, ChangeEvent, KeyboardEvent, useRef } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';

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
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  const handleClear = () => {
    onChange('');
    inputRef.current?.focus();
  };

  return (
    <div className={classNames('relative w-full bg-gray-25 rounded-3xl h-14', className)}>
      <input
        ref={inputRef}
        type="text"
        data-testid={dataTestId}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={onSubmit ? handleKeyDown : undefined}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        inputMode={inputMode}
        enterKeyHint={onSubmit ? (inputMode === 'url' ? 'go' : 'search') : 'done'}
        autoCapitalize={inputMode === 'url' ? 'none' : undefined}
        autoCorrect={inputMode === 'url' ? 'off' : undefined}
        spellCheck={inputMode === 'url' ? false : undefined}
        className={classNames(
          // pad right only while the clear button is shown so centered text doesn't sit under it
          'w-full bg-transparent outline-none py-4 text-base font-heading text-center',
          value ? 'pl-11 pr-11' : 'px-4',
          // #503 — placeholder must read as a hint, not a real value: lighter weight
          // than the bold input text, and hidden once the field is focused.
          'placeholder:text-placeholder-gray placeholder:font-normal placeholder:text-center',
          'focus:placeholder:text-transparent',
          'text-black font-bold'
        )}
      />
      {/* #503 — clear (X) affordance to erase the input, shown only when non-empty. */}
      {value && (
        <button
          type="button"
          aria-label={t('clear')}
          onClick={handleClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center"
        >
          <Icon name={IconName.CloseCircleFill} size="sm" className="text-placeholder-gray" fill="currentColor" />
        </button>
      )}
    </div>
  );
};

export default SearchInput;
