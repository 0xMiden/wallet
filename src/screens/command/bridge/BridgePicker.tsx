import React, { useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ListRow } from 'components/ui/ListRow';
import { Popover } from 'components/ui/Popover';
import { radioGroupKeyTarget } from 'components/ui/radio-group-keys';
import { SearchInput } from 'components/ui/SearchInput';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface BridgePickerOption {
  id: string;
  label: string;
  detail?: string;
  /** Extra text the search matches, e.g. the token's address. */
  keywords?: string;
  icon: (size: 'sm' | 'md') => React.ReactNode;
}

export interface BridgePickerProps {
  menuLabel: string;
  value: string;
  options: readonly BridgePickerOption[];
  onChange: (id: string) => void;
  searchable?: boolean;
  'data-testid': string;
}

const PILL =
  'flex min-h-11 min-w-0 items-center gap-2 rounded-full border border-hairline bg-page px-3 text-body text-ink';

/** A pill naming the current choice, opening a menu of the others; plain text when there is no other. */
export function BridgePicker({
  menuLabel,
  value,
  options,
  onChange,
  searchable,
  'data-testid': testId
}: BridgePickerProps): React.ReactElement {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // A catalog refresh can leave one option behind an open menu.
  if (open && options.length < 2) setOpen(false);

  const current = options.find(option => option.id === value) ?? options[0];
  if (!current)
    return (
      <button type="button" disabled data-testid={testId} className={cn(PILL, 'text-muted')}>
        {t('unavailable')}
      </button>
    );
  if (options.length === 1)
    return (
      <span data-testid={testId} className={PILL}>
        {current.icon('sm')}
        <span className="truncate">{current.label}</span>
      </span>
    );

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter(option =>
        [option.label, option.detail, option.keywords].some(text => text?.toLowerCase().includes(needle))
      )
    : options;
  const focusId = (shown.find(option => option.id === value) ?? shown[0])?.id;
  const rows = () => [...(rowsRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
  const openMenu = () => {
    setQuery('');
    setOpen(true);
  };
  const select = (id: string) => {
    if (id !== value) onChange(id);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${menuLabel}: ${current.label}`}
        data-testid={testId}
        onClick={() => {
          hapticLight();
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          openMenu();
        }}
        className={cn(PILL, 'focus-visible:outline-2 focus-visible:outline-accent-primary')}
      >
        {current.icon('sm')}
        <span className="truncate">{current.label}</span>
        <Icon name={IconName.ChevronDown} size="xs" fill="currentColor" aria-hidden="true" className="text-muted" />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        align="start"
        aria-label={menuLabel}
        data-testid={`${testId}-menu`}
      >
        <div className="flex flex-col gap-2 p-2">
          <h2 className="px-2 pt-1 text-label text-muted">{menuLabel}</h2>
          {searchable && (
            <div
              // The popover scrolls: the padding, cancelled by margin, keeps rows from showing around the field.
              className="sticky top-0 z-10 -mx-2 -my-2 bg-page px-2 py-2"
              onKeyDown={event => {
                // Left, Right, Home and End stay with the caret.
                const target = event.key === 'ArrowDown' ? rows()[0] : event.key === 'ArrowUp' ? rows().at(-1) : null;
                if (!target) return;
                event.preventDefault();
                target.focus();
              }}
            >
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder={t('searchByNameOrSymbol')}
                data-testid={`${testId}-search`}
              />
            </div>
          )}
          <div
            ref={rowsRef}
            role="radiogroup"
            aria-label={menuLabel}
            onKeyDown={event => {
              const list = rows();
              const from = list.indexOf(event.target as HTMLElement);
              if (from < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const to = radioGroupKeyTarget(event.key, list.length, from);
              if (to === null) return;
              event.preventDefault();
              list[to]?.focus();
            }}
          >
            {shown.map(option => (
              <ListRow
                key={option.id}
                variant="choice"
                radio
                checked={option.id === value}
                title={option.label}
                subtitle={option.detail}
                avatar={option.icon('md')}
                tabIndex={option.id === focusId ? 0 : -1}
                onClick={() => select(option.id)}
                // A focused row must not scroll to rest under the pinned search.
                className={cn('rounded-xl', searchable && 'scroll-mt-16')}
                data-testid={`bridge-option-${option.id}`}
              />
            ))}
          </div>
          {searchable && (
            // Always mounted: a live region added together with its text is not reliably announced.
            <p role="status" className={shown.length === 0 ? 'px-2 py-3 text-body-sm text-muted' : 'sr-only'}>
              {shown.length === 0 ? t('commandBridgeNoTokens') : null}
            </p>
          )}
        </div>
      </Popover>
    </>
  );
}
