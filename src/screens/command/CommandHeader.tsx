import React from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { IconButton } from 'components/ui/IconButton';
import { navigate } from 'lib/woozie';

export function CommandHeader(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-title-tab text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
        onClick={() => navigate('/')}
      >
        {t('commandWallet')}
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <Dialog.Trigger asChild>
          <IconButton icon={IconName.Search} label={t('commandSearch')} />
        </Dialog.Trigger>
        <Button size="sm" variant={ButtonVariant.Secondary} iconLeft={IconName.User} onClick={() => navigate('/me')}>
          {t('profile')}
        </Button>
      </div>
    </header>
  );
}
