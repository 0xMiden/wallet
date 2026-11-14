import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { navigate } from 'lib/woozie';

import type { CommandAction } from './command-routes';

export const COMMAND_DESTINATIONS: Record<CommandAction, string> = {
  send: '/send',
  receive: '/receive',
  swap: '/swap',
  earn: '/earn/positions',
  bridge: '/bridge/deposit'
};

const ACTIONS: CommandAction[] = ['send', 'receive', 'swap', 'earn', 'bridge'];

export function CommandDock(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t('commandActions')}
      className="flex shrink-0 flex-wrap justify-center gap-2 border-t border-hairline bg-page px-4 py-3"
    >
      {ACTIONS.map(action => (
        <Button
          key={action}
          size="sm"
          variant={ButtonVariant.Secondary}
          onClick={() => navigate(COMMAND_DESTINATIONS[action])}
        >
          {t(action === 'bridge' ? 'commandBridge' : action)}
        </Button>
      ))}
    </nav>
  );
}
