import React, { useEffect, useRef, useState } from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { IconButton } from 'components/ui/IconButton';
import { hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import type { CommandAction } from './command-routes';
import { COMMAND_DESTINATIONS } from './CommandDock';

const ACTIONS: CommandAction[] = ['send', 'receive', 'swap', 'earn', 'bridge'];

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
  const matches = ACTIONS.filter(action =>
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
  const choose = (action: CommandAction) => {
    hapticSelection();
    onOpenChange(false);
    navigate(COMMAND_DESTINATIONS[action]);
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
        className="fixed left-1/2 top-1/4 z-80 flex w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-3 rounded-2xl bg-page p-4 text-ink shadow-lg"
      >
        <div className="flex items-center justify-between">
          <Dialog.Title className="text-title-tab">{t('commandSearch')}</Dialog.Title>
          <Dialog.Close asChild>
            <IconButton icon={IconName.Close} label={t('close')} />
          </Dialog.Close>
        </div>
        <input
          ref={input}
          role="combobox"
          aria-label={t('commandSearch')}
          aria-expanded="true"
          aria-controls="command-palette-options"
          aria-activedescendant={selected >= 0 ? `command-palette-${matches[selected]}` : undefined}
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
              choose(matches[Math.max(0, selected)]!);
            }
          }}
          className="w-full rounded-xl bg-fill p-3 text-body text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        />
        <div id="command-palette-options" role="listbox" aria-label={t('commandActions')}>
          {matches.map((action, index) => (
            <button
              id={`command-palette-${action}`}
              role="option"
              aria-selected={index === selected}
              key={action}
              type="button"
              onClick={() => choose(action)}
              className="block w-full rounded-xl p-3 text-left text-body text-ink hover:bg-fill focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              {t(action === 'bridge' ? 'commandBridge' : action)}
            </button>
          ))}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
