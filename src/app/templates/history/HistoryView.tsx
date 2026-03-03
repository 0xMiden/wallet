import React, { memo, RefObject, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';
import InfiniteScroll from 'react-infinite-scroller';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import { isMobile } from 'lib/platform';

import HistoryItem from './HistoryItem';
import { IHistoryEntry } from './IHistoryEntry';

type HistoryViewProps = {
  entries: IHistoryEntry[];
  initialLoading: boolean;
  loadMore: (page: number) => Promise<void>;
  hasMore: boolean;
  scrollParentRef?: RefObject<HTMLDivElement>;
  fullHistory?: boolean;
  className?: string;
};

// Group entries by date (DD.MM.YYYY)
function groupEntriesByDate(entries: IHistoryEntry[]): Map<string, IHistoryEntry[]> {
  const groups = new Map<string, IHistoryEntry[]>();

  for (const entry of entries) {
    const date = new Date(entry.timestamp * 1000); // Convert seconds to milliseconds
    const dateKey = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;

    const existing = groups.get(dateKey);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(dateKey, [entry]);
    }
  }

  return groups;
}

// Date separator component - dashed line with date in center
const DateSeparator: React.FC<{ date: string; isFirst?: boolean }> = ({ date, isFirst }) => {
  return (
    <div className="flex justify-start pt-4">
      <span className="px-4 py-2 text-xs text-black rounded-5 bg-white">{date}</span>
    </div>
  );
};

const HistoryView = memo<HistoryViewProps>(
  ({ entries, initialLoading, loadMore, hasMore, scrollParentRef, fullHistory, className }) => {
    const { t } = useTranslation();
    const noEntries = entries.length === 0;
    const noOperationsClass = fullHistory
      ? 'mt-8 items-center text-left text-black'
      : 'm-4 items-start text-left text-black';
    // Group entries by date
    const groupedEntries = useMemo(() => groupEntriesByDate(entries), [entries]);
    if (noEntries) {
      return initialLoading ? (
        <ActivitySpinner />
      ) : (
        <div className={classNames('mb-12', 'flex flex-col justify-left', noOperationsClass)}>
          <h3 className="text-sm text-left" style={{ maxWidth: '20rem' }}>
            {t('noOperationsFound')}
          </h3>
        </div>
      );
    }

    // Handle summary view in Explore page (no grouping)
    if (!scrollParentRef || !fullHistory) {
      return (
        <>
          <div className={classNames('w-full', 'flex flex-col', className)}>
            {entries?.map((entry, index) => (
              <HistoryItem
                entry={entry}
                key={entry.key}
                fullHistory={fullHistory}
                lastEntry={index === entries.length - 1}
              />
            ))}
          </div>
        </>
      );
    }

    // Handle full page view from AllHistory - with date grouping
    const dateGroups = Array.from(groupedEntries.entries());
    return (
      <div className={classNames('w-full pb-6 flex flex-col', className)}>
        <div className="flex justify-center pt-2">
          <span className="text-xs text-black/50  font-medium flex items-center gap-1">
            {t('sortBy')}:{' '}
            <span className="flex items-center gap-2 cursor-pointer">
              <span className="text-black font-semibold">{t('recent')}</span>{' '}
              <Icon name={IconName.ChevronDownLucide} className="w-[10px] h-[10px]" />
            </span>
          </span>
        </div>

        <InfiniteScroll
          loadMore={loadMore}
          hasMore={hasMore}
          useWindow={false}
          getScrollParent={() => scrollParentRef.current}
        >
          <div className="px-1">
            {dateGroups.map(([dateKey, dateEntries], groupIndex) => (
              <div key={dateKey}>
                <DateSeparator date={dateKey} isFirst={groupIndex === 0} />
                <div className="flex flex-col">
                  {dateEntries.map((entry, index) => (
                    <HistoryItem
                      entry={entry}
                      key={entry.key}
                      fullHistory={fullHistory}
                      lastEntry={index === dateEntries.length - 1}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </InfiniteScroll>
      </div>
    );
  }
);

export default HistoryView;
