import React, { memo, RefObject, useMemo } from 'react';

import classNames from 'clsx';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import InfiniteScroll from 'react-infinite-scroller';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import { ReactComponent as FailedCrossIcon } from 'app/icons/v2/failed-cross.svg';
import { ReactComponent as SwapIcon } from 'app/icons/v2/swap.svg';
import { ActivityRow } from 'components/ui';
import type { ActivityAmountDirection, ActivityRowProps } from 'components/ui';
import { navigate } from 'lib/woozie';

import HistoryItem from './HistoryItem';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import {
  BRIDGE_STATUS_LABEL_KEY,
  bridgeInRowDisplay,
  bridgeRowDisplay,
  isBridgeInEntry,
  isFaucetRequest
} from './transactionUtils';

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

type Translate = (key: string, options?: Record<string, unknown>) => string;
type RowVisualKind = 'cancelled' | 'failed' | 'faucet' | 'receive' | 'send' | 'swap' | 'earn' | 'mint' | 'default';
type RowVisual = Pick<ActivityRowProps, 'icon' | 'iconBg'> & {
  amountDirection: ActivityAmountDirection;
};

interface RowState {
  faucet: boolean;
  cancelled: boolean;
  failed: boolean;
  swap: boolean;
}

const ROW_VISUALS: Record<RowVisualKind, RowVisual> = {
  cancelled: { icon: <FailedCrossIcon />, iconBg: 'bg-gray-400', amountDirection: 'neutral' },
  failed: { icon: <FailedCrossIcon />, iconBg: 'bg-[#CC5D5D]', amountDirection: 'neutral' },
  faucet: {
    icon: <Icon name={IconName.Faucet} size="sm" className="[&_path]:fill-pure-white" fill="currentColor" />,
    iconBg: 'bg-tx-faucet',
    amountDirection: 'positive'
  },
  receive: {
    icon: <Icon name={IconName.Receive} size="sm" className="[&_path]:fill-pure-white" />,
    iconBg: 'bg-tx-received',
    amountDirection: 'positive'
  },
  send: {
    icon: <Icon name={IconName.Send} size="sm" className="[&_path]:fill-pure-white" />,
    iconBg: 'bg-tx-sent',
    amountDirection: 'negative'
  },
  swap: {
    icon: <Icon name={IconName.Convert} size="sm" className="[&_path]:stroke-pure-white" />,
    iconBg: 'bg-tx-swap',
    amountDirection: 'neutral'
  },
  earn: {
    icon: <Icon name={IconName.Earn} size="sm" className="[&_path]:fill-pure-white [&_path]:stroke-pure-white" />,
    iconBg: 'bg-tx-earn',
    amountDirection: 'negative'
  },
  mint: {
    icon: <Icon name={IconName.Earn} size="sm" className="[&_path]:fill-pure-white [&_path]:stroke-pure-white" />,
    iconBg: 'bg-tx-earn',
    amountDirection: 'positive'
  },
  default: {
    icon: <Icon name={IconName.More} size="sm" fill="currentColor" />,
    iconBg: 'bg-gray-50',
    amountDirection: 'neutral'
  }
};

const ICON_VISUAL_KIND: Partial<Record<NonNullable<IHistoryEntry['transactionIcon']>, RowVisualKind>> = {
  RECEIVE: 'receive',
  SEND: 'send',
  SWAP: 'swap'
};

const AMOUNT_SIGN: Record<ActivityAmountDirection, string> = {
  positive: '+',
  negative: '-',
  neutral: ''
};

function getRowState(entry: IHistoryEntry): RowState {
  const faucet = isFaucetRequest(entry);
  const cancelled = entry.isCancelled === true;
  const failed = !cancelled && (entry.transactionIcon === 'FAILED' || entry.message === 'Transaction failed');
  return {
    faucet,
    cancelled,
    failed,
    swap: !faucet && !failed && !cancelled && entry.txType === 'swap'
  };
}

function getRowVisualKind(entry: IHistoryEntry, state: RowState): RowVisualKind {
  if (state.cancelled) return 'cancelled';
  if (state.faucet) return 'faucet';
  if (state.failed) return 'failed';

  const iconKind = entry.transactionIcon && ICON_VISUAL_KIND[entry.transactionIcon];
  if (iconKind) return iconKind;
  if (entry.txType === 'earn-deposit') return 'earn';
  if (entry.transactionIcon === 'MINT') return 'mint';
  return 'default';
}

function getRowTitle(entry: IHistoryEntry, state: RowState, t: Translate): string {
  if (state.cancelled) return t('cancelled');
  if (state.faucet) return t('faucetRequestTitle');
  if (state.swap && entry.token && entry.requestedToken) {
    return `${t('swap')} ${entry.token} → ${entry.requestedToken}`;
  }
  return entry.message || '';
}

function getRowSubtitle(entry: IHistoryEntry, state: RowState, t: Translate): string | undefined {
  if (state.swap) return t('viaInProtocolDex');
  if (!entry.secondaryAddress) return undefined;

  const direction = entry.transactionIcon === 'RECEIVE' || state.faucet ? t('from') : t('to');
  return `${direction}: ${shortAddr(entry.secondaryAddress)}`;
}

function getRowAmount(
  entry: IHistoryEntry,
  state: RowState,
  direction: ActivityAmountDirection
): ActivityRowProps['amount'] {
  if (state.swap && entry.requestedAmount) {
    return { value: entry.requestedAmount, symbol: entry.requestedToken, direction: 'neutral' };
  }
  if (entry.amount === undefined) return undefined;

  return { value: `${AMOUNT_SIGN[direction]}${entry.amount.toString()}`, symbol: entry.token, direction };
}

function getRowStatus(entry: IHistoryEntry, state: RowState, t: Translate): NonNullable<ActivityRowProps['status']> {
  if (state.cancelled) return { label: t('cancelled'), tone: 'cancelled' };
  if (state.failed) return { label: t('failed'), tone: 'failed' };

  const pending =
    entry.type === HistoryEntryType.PendingTransaction || entry.type === HistoryEntryType.ProcessingTransaction;
  if (pending) return { label: t('pending'), tone: 'pending' };
  return { label: t('confirmed'), tone: 'confirmed' };
}

function getBridgeAmount(
  outAmount: string | undefined,
  outSymbol: string,
  bridgeIn: boolean
): ActivityRowProps['amount'] {
  if (!outAmount) return undefined;
  const direction = bridgeIn ? 'positive' : 'neutral';
  return { value: `${AMOUNT_SIGN[direction]}${outAmount} ${outSymbol}`, direction };
}

function buildBridgeRowProps(entry: IHistoryEntry, t: Translate): ActivityRowProps {
  const bridgeIn = entry.txType !== 'bridged-send';
  const display = bridgeIn ? bridgeInRowDisplay(entry) : bridgeRowDisplay(entry);

  return {
    icon: <SwapIcon className="w-5 h-5" />,
    iconBg: 'bg-[#777487]',
    title: t('bridgeRowTitle', { from: display.inSymbol, to: display.outSymbol }),
    subtitle: t('bridgeRowVia', { provider: display.providerLabel, network: display.network }),
    amount: getBridgeAmount(display.outAmount, display.outSymbol, bridgeIn),
    status: { label: t(BRIDGE_STATUS_LABEL_KEY[display.status]), tone: display.status }
  };
}

function buildRowProps(entry: IHistoryEntry, t: Translate): ActivityRowProps {
  const bridge = !entry.isCancelled && (entry.txType === 'bridged-send' || isBridgeInEntry(entry));
  if (bridge) return buildBridgeRowProps(entry, t);

  const state = getRowState(entry);
  const visual = ROW_VISUALS[getRowVisualKind(entry, state)];
  return {
    icon: visual.icon,
    iconBg: visual.iconBg,
    title: getRowTitle(entry, state, t),
    subtitle: getRowSubtitle(entry, state, t),
    amount: getRowAmount(entry, state, visual.amountDirection),
    status: getRowStatus(entry, state, t)
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
