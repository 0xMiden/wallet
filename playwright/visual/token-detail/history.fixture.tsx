import React from 'react';
import type { ReactNode } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import type { PendingActivityItem } from 'app/templates/history/PendingActivityCard';
import { ActivityRow } from 'components/ui/ActivityRow';
import { Card } from 'components/ui/Card';

type HistoryFixtureProps = {
  pendingItems?: PendingActivityItem[];
  drawnPendingItems?: PendingActivityItem[];
  renderPendingItem?: (item: PendingActivityItem) => ReactNode;
  externalLoading?: boolean;
};

export default function History({
  pendingItems = [],
  drawnPendingItems = pendingItems,
  renderPendingItem,
  externalLoading
}: HistoryFixtureProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="token-history-fixture" data-pending-count={drawnPendingItems.length}>
      <Card asChild surface="outline" padding="row" className="relative">
        <ActivityRow
          testId="token-history-fixture-row"
          icon={<Icon name={IconName.Receive} size="sm" className="text-pure-white" />}
          iconBg="bg-tx-received"
          title={t('received')}
          subtitle={t('testnet')}
          amount={{ value: '+0.10', symbol: 'IETH', direction: 'positive' }}
          status="received"
        />
      </Card>
      {drawnPendingItems.map(item => (
        <div key={item.note.id} data-testid="token-history-pending-row">
          {renderPendingItem?.(item)}
        </div>
      ))}
      {externalLoading && <div data-testid="token-history-loading" role="status">Loading history</div>}
    </div>
  );
}
