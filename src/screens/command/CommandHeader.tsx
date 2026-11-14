import React from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { IconButton } from 'components/ui/IconButton';
import { navigate } from 'lib/woozie';

export function CommandHeader(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
      <button
        type="button"
        className="text-title-tab text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
        onClick={() => navigate('/')}
      >
        {t('commandWallet')}
      </button>
      <Dialog.Trigger asChild>
        <IconButton icon={IconName.Search} label={t('commandSearch')} />
      </Dialog.Trigger>
    </header>
  );
}
