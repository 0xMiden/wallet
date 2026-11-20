import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { navigate } from 'lib/woozie';

import type { CommandAction } from './command-routes';

export const COMMAND_DESTINATIONS: Record<CommandAction, string> = {
  send: '/send',
  receive: '/receive',
  swap: '/swap',
  earn: '/earn',
  bridge: '/bridge/deposit'
};

export const COMMAND_ACTION_ICONS = [
  ['send', IconName.Send],
  ['receive', IconName.Receive],
  ['swap', IconName.Convert],
  ['earn', IconName.Earn],
  ['bridge', IconName.BridgeIn]
] as const;

export function CommandDock({ activeAction }: { activeAction?: CommandAction }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t('commandActions')}
      className="pointer-events-auto absolute inset-x-0 bottom-4 z-20 mx-auto flex w-[calc(100%-1.5rem)] max-w-[29rem] items-stretch gap-1 rounded-[1.625rem] border border-ink/25 bg-fill bg-linear-to-b from-ink/10 to-transparent p-2 shadow-2xl ring-1 ring-inset ring-ink/5 supports-backdrop-filter:bg-fill/85 [backdrop-filter:blur(24px)_saturate(1.4)] [-webkit-backdrop-filter:blur(24px)_saturate(1.4)] sm:bottom-6 sm:gap-2 sm:p-2.5"
    >
      {COMMAND_ACTION_ICONS.map(([action, icon]) => (
        <Button
          key={action}
          size="sm"
          variant={ButtonVariant.CommandShortcut}
          aria-current={activeAction === action ? 'page' : undefined}
          className="h-auto min-h-14 gap-1.5 rounded-2xl px-1 py-2 text-caption hover:bg-accent-tint hover:text-accent-tint-ink focus-visible:ring-offset-0 aria-[current=page]:bg-accent-tint aria-[current=page]:text-accent-tint-ink aria-[current=page]:ring-1 aria-[current=page]:ring-inset aria-[current=page]:ring-accent-primary/30 sm:px-2"
          onClick={() => navigate(COMMAND_DESTINATIONS[action])}
        >
          <Icon name={icon} aria-hidden="true" className="h-5 w-5 shrink-0" />
          <span className="w-full wrap-anywhere text-center leading-tight">
            {t(action === 'bridge' ? 'commandBridge' : action)}
          </span>
        </Button>
      ))}
    </nav>
  );
}
