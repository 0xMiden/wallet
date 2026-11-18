import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { EmptyState } from 'components/ui';

import { useCommandPrivacy } from './useCommandPrivacy';

export function CommandOperation({ children }: { children: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const [hidden, setHidden] = useCommandPrivacy();

  if (hidden)
    return (
      <EmptyState
        icon={IconName.ArrowUpDown}
        title={t('commandMaskedBalance')}
        secondaryAction={{
          label: t('commandShowBalances'),
          onClick: () => {
            void setHidden(false).catch(() => console.warn('[command] privacy preference unavailable'));
          }
        }}
      />
    );

  return <>{children}</>;
}
