import React, { useEffect, useRef, useState } from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { IconButton } from 'components/ui/IconButton';
import { hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import type { CommandAction } from './command-routes';
import { COMMAND_ACTION_ICONS, COMMAND_DESTINATIONS } from './CommandDock';

const ACTIONS = [...COMMAND_ACTION_ICONS, ['explore', IconName.Explore]] as const;

export function CommandPalette({
  open,
  onOpenChange,
  container
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: HTMLElement | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const matches = ACTIONS.filter(([action]) =>
    t(action === 'bridge' ? 'commandBridge' : action)
      .toLowerCase()
      .includes(query.toLowerCase())
  );
  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(-1);
    }
  }, [open]);
  const choose = (action: CommandAction | 'explore') => {
    hapticSelection();
    onOpenChange(false);
    navigate(action === 'explore' ? '/browser' : COMMAND_DESTINATIONS[action]);
  };
  return (
    <Dialog.Portal container={container ?? undefined}>
      <Dialog.Overlay className="fixed inset-0 z-80 bg-scrim" />
      <Dialog.Content
        aria-describedby={undefined}
        onOpenAutoFocus={event => {
          event.preventDefault();
          input.current?.focus();
        }}
        className="fixed left-1/2 top-[15dvh] z-80 flex max-h-[75dvh] w-[min(35rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-3xl border border-accent-tint-ink/35 bg-page bg-linear-to-br from-fill to-page text-ink shadow-2xl"
      >
        <Dialog.Title className="sr-only">{t('commandSearch')}</Dialog.Title>
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline p-4">
          <Icon name={IconName.Search} size="sm" className="shrink-0 text-accent-tint-ink" aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-label={t('commandSearch')}
            aria-expanded="true"
            aria-controls="command-palette-options"
            aria-activedescendant={selected >= 0 ? `command-palette-${matches[selected]?.[0]}` : undefined}
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setSelected(-1);
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown' && matches.length) {
                event.preventDefault();
                setSelected((selected + 1) % matches.length);
              }
              if (event.key === 'ArrowUp' && matches.length) {
                event.preventDefault();
                setSelected((selected + matches.length - 1) % matches.length);
              }
              if (event.key === 'Enter' && matches.length) {
                event.preventDefault();
                choose(matches[Math.max(0, selected)]![0]);
              }
            }}
            placeholder={t('commandSearch')}
            className="min-w-0 flex-1 rounded-xl border border-hairline bg-page p-3 text-body text-ink outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent-primary"
          />
          <Dialog.Close asChild>
            <IconButton icon={IconName.Close} label={t('close')} />
          </Dialog.Close>
        </div>
        <div
          id="command-palette-options"
          role="listbox"
          aria-label={t('commandActions')}
          className="min-h-0 overflow-y-auto p-2"
        >
          {matches.map(([action, icon], index) => (
            <button
              id={`command-palette-${action}`}
              role="option"
              aria-selected={index === selected}
              key={action}
              type="button"
              onClick={() => choose(action)}
              className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left text-body text-ink hover:bg-fill aria-selected:bg-accent-tint focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-hairline bg-fill text-accent-tint-ink">
                <Icon name={icon} size="sm" aria-hidden="true" />
              </span>
              <span>{t(action === 'bridge' ? 'commandBridge' : action)}</span>
            </button>
          ))}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
