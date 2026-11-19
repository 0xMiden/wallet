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

const ACTIONS = [
  ['send', IconName.Send],
  ['receive', IconName.Receive],
  ['swap', IconName.Convert],
  ['earn', IconName.Earn],
  ['bridge', IconName.BridgeIn]
] as const;

export function CommandDock(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t('commandActions')}
      className="pointer-events-auto absolute inset-x-0 bottom-4 z-20 mx-auto flex w-[calc(100%-1.5rem)] max-w-md gap-1 rounded-[1.625rem] border border-white/25 bg-[#302820] p-2 shadow-2xl supports-backdrop-filter:bg-[#302820]/85 [backdrop-filter:blur(24px)_saturate(1.4)] [-webkit-backdrop-filter:blur(24px)_saturate(1.4)] sm:bottom-6"
    >
      {ACTIONS.map(([action, icon]) => (
        <Button
          key={action}
          size="sm"
          variant={ButtonVariant.CommandShortcut}
          className="h-14 px-1.5"
          onClick={() => navigate(COMMAND_DESTINATIONS[action])}
        >
          <Icon name={icon} aria-hidden="true" className="h-5 w-5 shrink-0" />
          <span className="truncate">{t(action === 'bridge' ? 'commandBridge' : action)}</span>
        </Button>
      ))}
    </nav>
  );
}
