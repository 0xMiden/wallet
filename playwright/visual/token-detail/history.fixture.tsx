import HistoryView from 'app/templates/history/HistoryView';
import { HistoryEntryType, type IHistoryEntry } from 'app/templates/history/IHistoryEntry';
import type { PendingActivityItem } from 'app/templates/history/PendingActivityCard';

import { FIXTURE_NOW } from './history.leaves';

// The real list over synthetic rows: `History` itself reads the wallet database. Seven settled rows,
// so the page's row cap has something to cut.
const entries: IHistoryEntry[] = Array.from({ length: 7 }, (_, index) => ({
  key: `fixture-${index}`,
  address: 'synthetic-account',
  timestamp: FIXTURE_NOW - 600 - index * 60,
  message: 'Received',
  type: HistoryEntryType.CompletedTransaction,
  txType: 'consume',
  amount: `${index + 1}.00`,
  token: 'IETH'
}));
const loadNothing = async () => undefined;

type Props = {
  tokenId?: string;
  numItems?: number;
  dateStyle?: 'header' | 'caption';
  drawnPendingItems?: PendingActivityItem[];
  renderPendingItem?: (item: PendingActivityItem) => React.ReactNode;
};

export default function History({ tokenId, numItems, dateStyle, drawnPendingItems, renderPendingItem }: Props) {
  return (
    <HistoryView
      entries={entries.slice(0, numItems)}
      maxRows={numItems}
      pendingItems={drawnPendingItems}
      renderPendingItem={renderPendingItem}
      initialLoading={false}
      hasMore={false}
      loadMore={loadNothing}
      tokenId={tokenId}
      dateStyle={dateStyle}
      fullHistory
    />
  );
}
