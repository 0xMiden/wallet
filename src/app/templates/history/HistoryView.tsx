import React, { memo, RefObject, useMemo } from 'react';

import classNames from 'clsx';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import InfiniteScroll from 'react-infinite-scroller';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import { ActivityRow, ActivityStatusTone } from 'components/ui';
import { navigate } from 'lib/woozie';

import HistoryItem from './HistoryItem';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { isFaucetRequest } from './transactionUtils';

type HistoryViewProps = {
  entries: IHistoryEntry[];
  initialLoading: boolean;
  loadMore: (page: number) => Promise<void>;
  hasMore: boolean;
  scrollParentRef?: RefObject<HTMLDivElement>;
  fullHistory?: boolean;
  centerEmptyState?: boolean;
  className?: string;
};

function groupEntriesByDate(entries: IHistoryEntry[]): Map<number, IHistoryEntry[]> {
  const groups = new Map<number, IHistoryEntry[]>();
  for (const entry of entries) {
    const d = new Date(entry.timestamp * 1000);
    const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}

const DateSeparator: React.FC<{ dateMs: number }> = ({ dateMs }) => {
  const d = new Date(dateMs);
  const longDate = format(d, 'MMMM d, yyyy');
  const day = format(d, 'EEEE');
  return (
    <div className="flex items-center justify-between font-heading font-extrabold text-heading-gray dark:text-pure-white text-base leading-[100%]">
      <span className="">{longDate}</span>
      <span className="text-accent-primary">{day}</span>
    </div>
  );
};

// Map an IHistoryEntry to the visual props ActivityRow expects: icon glyph,
// colored square background, amount string with sign, and status pill (dot +
// label). Faucet requests get their own dark-blue glyph regardless of icon.
function buildRowProps(entry: IHistoryEntry, t: (k: string) => string) {
  const faucet = isFaucetRequest(entry);
  const icon = entry.transactionIcon ?? 'DEFAULT';
  const isFailed = icon === 'FAILED' || entry.message === 'Transaction failed';

  let iconNode: React.ReactNode;
  let iconBg = 'bg-gray-50';
  let amountDirection: 'positive' | 'negative' | 'neutral' = 'neutral';

  // Glyphs mirror the home action-bar logos (Send / Receive / Earn / Swap),
  // rendered white over their own hue (set as `iconBg`). The source SVGs ship
  // with hardcoded fills/strokes, so force them white via `[&_path]:*` here.
  if (faucet) {
    iconNode = <Icon name={IconName.Faucet} size="sm" className="[&_path]:fill-pure-white" fill="currentColor" />;
    iconBg = 'bg-tx-faucet';
    amountDirection = 'positive';
  } else if (isFailed) {
    iconNode = <Icon name={IconName.Close} size="sm" fill="currentColor" />;
    iconBg = 'bg-status-negative';
  } else if (icon === 'RECEIVE') {
    iconNode = <Icon name={IconName.Receive} size="sm" className="[&_path]:fill-pure-white" />;
    iconBg = 'bg-tx-received';
    amountDirection = 'positive';
  } else if (icon === 'SEND') {
    iconNode = <Icon name={IconName.Send} size="sm" className="[&_path]:fill-pure-white" />;
    iconBg = 'bg-tx-sent';
    amountDirection = 'negative';
  } else if (icon === 'SWAP') {
    iconNode = <Icon name={IconName.Convert} size="sm" className="[&_path]:stroke-pure-white" />;
    iconBg = 'bg-tx-swap';
    amountDirection = 'neutral';
  } else if (icon === 'MINT') {
    iconNode = <Icon name={IconName.Earn} size="sm" className="[&_path]:fill-pure-white [&_path]:stroke-pure-white" />;
    iconBg = 'bg-tx-earn';
    amountDirection = 'positive';
  } else {
    iconNode = <Icon name={IconName.More} size="sm" fill="currentColor" />;
  }

  const title = faucet ? t('faucetRequestTitle') : entry.message || '';
  const subtitle = entry.secondaryAddress
    ? `${icon === 'RECEIVE' || faucet ? t('from') : t('to')}: ${shortAddr(entry.secondaryAddress)}`
    : undefined;

  let amount: { value: string; symbol?: string; direction: 'positive' | 'negative' | 'neutral' } | undefined;
  if (entry.amount !== undefined) {
    const sign = amountDirection === 'positive' ? '+' : amountDirection === 'negative' ? '-' : '';
    amount = { value: `${sign}${entry.amount.toString()}`, symbol: entry.token, direction: amountDirection };
  }

  let statusTone: ActivityStatusTone = 'confirmed';
  let statusLabel = t('confirmed');
  if (isFailed) {
    statusTone = 'failed';
    statusLabel = t('failed');
  } else if (
    entry.type === HistoryEntryType.PendingTransaction ||
    entry.type === HistoryEntryType.ProcessingTransaction
  ) {
    statusTone = 'pending';
    statusLabel = t('pending');
  }

  return {
    icon: iconNode,
    iconBg,
    title,
    subtitle,
    amount,
    status: { label: statusLabel, tone: statusTone }
  };
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  const underscoreIdx = addr.indexOf('_');
  if (underscoreIdx === -1) return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return `${addr.slice(0, 6)}…${addr.slice(-7)}`;
}

const HistoryView = memo<HistoryViewProps>(
  ({ entries, initialLoading, loadMore, hasMore, scrollParentRef, fullHistory, centerEmptyState, className }) => {
    const { t } = useTranslation();
    const noEntries = entries.length === 0;
    const noOperationsClass = fullHistory
      ? 'mt-8 items-center text-left text-black'
      : 'm-4 items-start text-left text-black';
    const groupedEntries = useMemo(() => groupEntriesByDate(entries), [entries]);

    if (noEntries) {
      if (initialLoading) return <ActivitySpinner />;
      if (centerEmptyState) {
        return (
          <div className="flex flex-col items-center justify-center flex-1 pt-16">
            <Icon name={IconName.ArrowUpDown} size="xl" fill="currentColor" className="mb-4 text-text-tertiary-token" />
            <p className="font-heading text-sm text-center text-text-tertiary-token">{t('noOperationsFound')}</p>
          </div>
        );
      }
      return (
        <div className={classNames('mb-12', 'flex flex-col justify-left', noOperationsClass)}>
          <h3 className="text-sm text-left" style={{ maxWidth: '20rem' }}>
            {t('noOperationsFound')}
          </h3>
        </div>
      );
    }

    // Summary view (used outside the full Activity page) keeps the legacy
    // HistoryItem look — small list of recent entries, no grouping or chrome.
    if (!fullHistory) {
      return (
        <div className={classNames('w-full', 'flex flex-col', className)}>
          {entries.map((entry, index) => (
            <HistoryItem
              entry={entry}
              key={entry.key}
              fullHistory={fullHistory}
              lastEntry={index === entries.length - 1}
            />
          ))}
        </div>
      );
    }

    const dateGroups = Array.from(groupedEntries.entries());

    const list = (
      <div className="flex flex-col">
        {dateGroups.map(([dateMs, dateEntries], index) => (
          <div
            key={dateMs}
            className={classNames('flex flex-col gap-1 py-3 border-b-[#BABABA33] border-b', index === 0 && 'pt-4')}
          >
            <DateSeparator dateMs={dateMs} />
            <div className="flex flex-col divide-y divide-rule-default dark:divide-pure-white">
              {dateEntries.map(entry => {
                const props = buildRowProps(entry, t);
                return (
                  <ActivityRow
                    key={entry.key}
                    icon={props.icon}
                    iconBg={props.iconBg}
                    title={props.title}
                    subtitle={props.subtitle}
                    amount={props.amount}
                    status={props.status}
                    onClick={entry.txId ? () => navigate(`/history-details/${entry.txId}`) : undefined}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );

    return (
      <div className={classNames('w-full pb-6 flex flex-col', className)}>
        {scrollParentRef ? (
          <InfiniteScroll
            loadMore={loadMore}
            hasMore={hasMore}
            useWindow={false}
            getScrollParent={() => scrollParentRef.current}
          >
            {list}
          </InfiniteScroll>
        ) : (
          list
        )}
      </div>
    );
  }
);

export default HistoryView;
