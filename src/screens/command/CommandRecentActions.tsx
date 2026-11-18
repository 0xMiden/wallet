import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { ClaimsLoadingBar } from 'app/templates/history/ActivityClaimsStatus';
import History from 'app/templates/history/History';
import HistoryItem from 'app/templates/history/HistoryItem';
import { HistoryLoadErrorCard, HistoryLoadErrorNotice } from 'app/templates/history/HistoryView';
import { useActivityClaimList } from 'app/templates/history/useActivityClaimList';
import { EmptyState, SectionHeader, Spinner, TextAction } from 'components/ui';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { navigate } from 'lib/woozie';

import { useCommandPrivacy } from './useCommandPrivacy';

const RECENT_ACTION_COUNT = 5;

export function CommandRecentActions({ scope }: { scope: AccountScope }): React.ReactElement {
  const { t } = useTranslation();
  const [hidden] = useCommandPrivacy();

  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-8" aria-label={t('commandRecentActions')}>
      <SectionHeader
        size="xl"
        action={!hidden && <TextAction onClick={() => navigate('/history')}>{t('activity')}</TextAction>}
      >
        {t('commandRecentActions')}
      </SectionHeader>
      {hidden ? (
        <EmptyState icon={IconName.ArrowUpDown} size="compact" title={t('commandMaskedBalance')} />
      ) : (
        <RecentActionsList scope={scope} />
      )}
    </section>
  );
}

function RecentActionsList({ scope }: { scope: AccountScope }): React.ReactElement {
  const { t } = useTranslation();
  const { account, representedItems, listItems, renderPendingItem, isLoadingNotes } = useActivityClaimList('', 'all');
  const claims = account.publicKey === scope.accountId ? listItems : [];
  const representedClaims = account.publicKey === scope.accountId ? representedItems : [];
  const claimTransactionIds = new Set(claims.flatMap(item => (item.txId ? [item.txId] : [])));

  return (
    <History
      address={scope.accountId}
      pendingItems={representedClaims}
      renderEntries={view => {
        const recent = [
          ...view.entries
            .filter(entry => !entry.txId || !claimTransactionIds.has(entry.txId))
            .map(entry => ({ entry, timestamp: entry.timestamp, key: entry.key })),
          ...claims.map(item => ({ item, timestamp: item.note.receivedAt ?? Number.NaN, key: item.note.id }))
        ]
          .sort(
            (a, b) =>
              (Number.isFinite(b.timestamp) ? b.timestamp : -Infinity) -
              (Number.isFinite(a.timestamp) ? a.timestamp : -Infinity)
          )
          .slice(0, RECENT_ACTION_COUNT);

        if (recent.length === 0) {
          if (view.loadError) return <HistoryLoadErrorCard onRetry={view.onRetry} />;
          if (view.initialLoading || isLoadingNotes)
            return (
              <div className="flex justify-center py-5">
                <Spinner />
              </div>
            );
          return <EmptyState icon={IconName.ArrowUpDown} size="compact" title={t('commandNoRecentActions')} />;
        }

        return (
          <>
            {view.loadError && <HistoryLoadErrorNotice onRetry={view.onRetry} />}
            {isLoadingNotes && <ClaimsLoadingBar loading />}
            <div className="flex flex-col gap-3">
              {recent.map(action =>
                'entry' in action ? (
                  <HistoryItem key={action.key} entry={action.entry} />
                ) : (
                  <div key={`note-${action.key}`} data-pending-note-id={action.key}>
                    {renderPendingItem(action.item)}
                  </div>
                )
              )}
            </div>
          </>
        );
      }}
    />
  );
}
