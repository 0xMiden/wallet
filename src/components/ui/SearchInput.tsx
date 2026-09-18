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
  /** `md` (44px) in a page or sheet; `sm` (36px) fits a header row. Same look at both sizes. */
  size?: 'md' | 'sm';
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
  size = 'md',
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
    <div
      className={classNames(
        // Direction B: the shared `fill`, no border; an accent ring while typing.
        'relative flex w-full items-center rounded-full bg-fill',
        'focus-within:ring-[1.5px] focus-within:ring-accent-primary',
        size === 'sm' ? 'h-9' : 'h-11',
        className
      )}
    >
      <Icon
        name={IconName.Search}
        size="sm"
        fill="currentColor"
        aria-hidden="true"
        className={classNames('pointer-events-none absolute shrink-0 text-muted', size === 'sm' ? 'left-3' : 'left-4')}
      />
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
          // 16px text: anything smaller makes iOS zoom the page on focus. `font-sans` because
          // Preflight sets `font: inherit` and a query can be an address, which reads badly in the
          // rounded display face.
          'h-full w-full min-w-0 bg-transparent font-sans text-base font-medium text-ink outline-none',
          size === 'sm' ? 'pl-9' : 'pl-11',
          // Room for the clear button only while it shows.
          value ? 'pr-11' : 'pr-4',
          // #503 — the placeholder reads as a hint, lighter than typed text.
          'placeholder:font-normal placeholder:text-muted'
        )}
      />
      {/* #503 — clear (X) affordance to erase the input, shown only when non-empty. */}
      {value && (
        <button
          type="button"
          aria-label={t('clear')}
          onClick={handleClear}
          className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center"
        >
          <Icon name={IconName.CloseCircleFill} size="sm" className="text-muted" fill="currentColor" />
        </button>
      )}
    </div>
  );
};

export default SearchInput;
