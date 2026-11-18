import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { EmptyState, Spinner } from 'components/ui';
import { navigate } from 'lib/woozie';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

import { useCommandPrivacy } from './useCommandPrivacy';

export function CommandOperation({ id, children }: { id: string; children: React.ReactNode }): React.ReactElement {
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

  return <VisibleOperation id={id}>{children}</VisibleOperation>;
}

function VisibleOperation({ id, children }: { id: string; children: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(id);

  if (!loaded)
    return (
      <div className="flex justify-center py-5">
        <Spinner />
      </div>
    );
  if (!row)
    return (
      <EmptyState
        icon={IconName.ArrowUpDown}
        title={t('noOperationsFound')}
        secondaryAction={{ label: t('activity'), onClick: () => navigate('/history') }}
      />
    );

  return <>{children}</>;
}
