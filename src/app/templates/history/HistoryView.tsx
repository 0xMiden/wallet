import React, { memo, RefObject, useMemo } from 'react';

import classNames from 'clsx';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import InfiniteScroll from 'react-infinite-scroller';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { guardianEndpointDisplayName } from 'app/hooks/useCurrentGuardianEndpoint';
import { Icon, IconName } from 'app/icons/v2';
import { ReactComponent as FailedCrossIcon } from 'app/icons/v2/failed-cross.svg';
import { ReactComponent as SwapIcon } from 'app/icons/v2/swap.svg';
import { ActivityRow, ActivityRowProps, ActivityStatusTone } from 'components/ui';
import { navigate } from 'lib/woozie';

import HistoryItem from './HistoryItem';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import {
  BRIDGE_STATUS_LABEL_KEY,
  bridgeInRowDisplay,
  bridgeRowDisplay,
  EARN_DEPOSIT_STATUS_LABEL_KEY,
  EARN_WITHDRAW_STATUS_LABEL_KEY,
  earnDepositSettlementOf,
  earnWithdrawToneOf,
  isBridgeInEntry,
  isEarnWithdrawEntry,
  isFaucetRequest
} from './transactionUtils';

type HistoryViewProps = {
  entries: IHistoryEntry[];
  initialLoading: boolean;
  loadMore: (page: number) => Promise<void>;
  hasMore: boolean;
  scrollParentRef?: RefObject<HTMLDivElement>;
  /** Set on a token-scoped view (Token Detail); signs swap rows by side. */
  tokenId?: string;
  fullHistory?: boolean;
  centerEmptyState?: boolean;
  className?: string;
};

function groupEntriesByDate(entries: IHistoryEntry[]): Map<number, IHistoryEntry[]> {
  const groups = new Map<number, IHistoryEntry[]>();
  for (const entry of entries) {
    // A timestamp that isn't a usable number yields an Invalid Date, and
    // `DateSeparator` formats the group key with date-fns, which THROWS on one —
    // so a single bad row would take down the entire list rather than just
    // itself. Group those under today instead; the row is still listed.
    // `Number.isFinite` alone is not enough: 1e300 is finite but overflows the
    // Date range, and the result is an Invalid Date all the same. Build the date
    // first and test THAT, which is the only thing date-fns actually sees.
    const candidate = new Date(entry.timestamp * 1000);
    const d = Number.isFinite(candidate.getTime()) ? candidate : new Date();
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
function buildRowProps(
  entry: IHistoryEntry,
  t: (k: string, opts?: Record<string, unknown>) => string,
  tokenId?: string
) {
  // Bridge rows get a dedicated swap-style layout: "Bridge IN → OUT" / "Via
  // <provider> → <network>" / output amount / status dot. The Miden-side icon
  // (SEND) and signed amount don't apply. Bridge-in consumes (auto-consumed
  // EVM→Miden deposits) reuse the same layout with the direction flipped.
  // A user-cancelled bridge falls through to the plain cancelled row below.
  if (!entry.isCancelled && (entry.txType === 'bridged-send' || isBridgeInEntry(entry))) {
    const bridgeIn = entry.txType !== 'bridged-send';
    const d = bridgeIn ? bridgeInRowDisplay(entry) : bridgeRowDisplay(entry);
    const failed = d.status === 'failed';
    return {
      icon: failed ? <Icon name={IconName.Close} size="sm" fill="currentColor" /> : <SwapIcon className="w-5 h-5" />,
      iconBg: failed ? 'bg-status-negative' : 'bg-[#777487]',
      title: t('bridgeRowTitle', { from: d.inSymbol, to: d.outSymbol }),
      subtitle: t('bridgeRowVia', { provider: d.providerLabel, network: d.network }),
      amount: d.outAmount
        ? {
            value: `${bridgeIn ? '+' : ''}${d.outAmount} ${d.outSymbol}`,
            direction: bridgeIn ? ('positive' as const) : ('neutral' as const)
          }
        : undefined,
      status: { label: t(BRIDGE_STATUS_LABEL_KEY[d.status]), tone: d.status }
    };
  }

  // Smart Withdraw row: "Withdraw from Earn" / "Via Epoch → Miden" with a
  // positive incoming amount and a phase-driven status dot (Redeeming →
  // Delivering → Received, or Failed). Reuses the bridge status tones.
  if (!entry.isCancelled && isEarnWithdrawEntry(entry)) {
    const phase = entry.earnWithdrawPhase ?? 'redeeming';
    const failed = phase === 'failed';
    return {
      icon: failed ? (
        <FailedCrossIcon className="w-3.5 h-3.5" />
      ) : (
        <Icon name={IconName.Earn} size="sm" className="[&_path]:fill-pure-white [&_path]:stroke-pure-white" />
      ),
      iconBg: failed ? 'bg-status-negative' : 'bg-tx-earn',
      title: t('earnWithdrawRowTitle'),
      subtitle: t('earnWithdrawRowVia'),
      amount:
        failed || entry.amount === undefined
          ? undefined
          : { value: `+${entry.amount.toString()}`, symbol: entry.token, direction: 'positive' as const },
      status: { label: t(EARN_WITHDRAW_STATUS_LABEL_KEY[phase]), tone: earnWithdrawToneOf(phase) }
    };
  }

  const faucet = isFaucetRequest(entry);
  const icon = entry.transactionIcon ?? 'DEFAULT';
  const isCancelled = entry.isCancelled === true;
  const isFailed = !isCancelled && (icon === 'FAILED' || entry.message === 'Transaction failed');

  let iconNode: React.ReactNode;
  let iconBg = 'bg-gray-50';
  let amountDirection: 'positive' | 'negative' | 'neutral' = 'neutral';

  // Glyphs mirror the home action-bar logos (Send / Receive / Earn / Swap),
  // rendered white over their own hue (set as `iconBg`). The source SVGs ship
  // with hardcoded fills/strokes, so force them white via `[&_path]:*` here.
  if (isCancelled) {
    iconNode = <FailedCrossIcon className="w-3.5 h-3.5" />;
    iconBg = 'bg-gray-400';
  } else if (faucet) {
    iconNode = <Icon name={IconName.Faucet} size="sm" className="[&_path]:fill-pure-white" fill="currentColor" />;
    iconBg = 'bg-tx-faucet';
    amountDirection = 'positive';
  } else if (isFailed) {
    iconNode = <FailedCrossIcon className="w-3.5 h-3.5" />;
    iconBg = 'bg-[#CC5D5D]';
  } else if (entry.txType === 'switch-guardian') {
    iconNode = <SwapIcon className="w-5 h-5" />;
    iconBg = 'bg-[#777487]';
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
  } else if (entry.txType === 'earn-deposit') {
    // Position deposits carry a DEFAULT icon — tag them with the Earn glyph, or a red
    // cross when the lending leg settled `failed` so the row icon agrees with the red
    // "Failed" status chip rendered below (statusTone) for that same state.
    const earnFailed = earnDepositSettlementOf(entry) === 'failed';
    iconNode = earnFailed ? (
      <FailedCrossIcon className="w-3.5 h-3.5" />
    ) : (
      <Icon name={IconName.Earn} size="sm" className="[&_path]:fill-pure-white [&_path]:stroke-pure-white" />
    );
    iconBg = earnFailed ? 'bg-[#CC5D5D]' : 'bg-tx-earn';
    amountDirection = 'negative';
  } else {
    iconNode = <Icon name={IconName.More} size="sm" fill="currentColor" />;
  }

  // Swap rows read "Swap {offered} → {requested}" with the venue as the
  // subtitle, and show the requested side (what the user receives) on the right.
  const isSwap = !faucet && !isFailed && !isCancelled && entry.txType === 'swap';

  const title = isCancelled
    ? t('cancelled')
    : faucet
      ? t('faucetRequestTitle')
      : isSwap && entry.token && entry.requestedToken
        ? `${t('swap')} ${entry.token} → ${entry.requestedToken}`
        : entry.message || '';
  const subtitle =
    entry.txType === 'switch-guardian'
      ? `${guardianEndpointDisplayName(
          entry.previousGuardianEndpoint,
          t('unknown')
        )} → ${guardianEndpointDisplayName(entry.newGuardianEndpoint, t('unknown'))}`
      : isSwap
        ? t('viaInProtocolDex')
        : entry.secondaryAddress
          ? `${icon === 'RECEIVE' || faucet ? t('from') : t('to')}: ${shortAddr(entry.secondaryAddress)}`
          : undefined;

  // A swap row shows up in BOTH sides' token-scoped histories. On such a page
  // the row is read as a movement of *that* token, so show the matching side
  // and sign it: the offered token left the wallet, the requested one arrived.
  // The unscoped activity list has no side to privilege, so it keeps showing
  // the requested amount unsigned.
  const swapSide =
    isSwap && tokenId
      ? tokenId === entry.requestedFaucetId
        ? 'requested'
        : tokenId === entry.faucetId
          ? 'offered'
          : undefined
      : undefined;

  let amount: ActivityRowProps['amount'];
  if (swapSide === 'requested' && entry.requestedAmount) {
    amount = { value: `+${entry.requestedAmount}`, symbol: entry.requestedToken, direction: 'positive' };
  } else if (swapSide === 'offered' && entry.amount !== undefined) {
    amount = { value: `-${entry.amount.toString()}`, symbol: entry.token, direction: 'negative' };
  } else if (isSwap && entry.requestedAmount) {
    amount = { value: entry.requestedAmount, symbol: entry.requestedToken, direction: 'neutral' };
    // `entry.token` on its own is enough: a faucet that resolved only to the
    // unknown-token placeholder yields a symbol and no amount, and skipping the
    // block over that would drop the asset's NAME too — leaving a row that says
    // nothing about what moved.
  } else if (entry.amount !== undefined || entry.extraAmounts?.length || entry.token !== undefined) {
    const sign = amountDirection === 'positive' ? '+' : amountDirection === 'negative' ? '-' : '';
    // A batch claim spanning several faucets appends each further asset inline —
    // but only on the unscoped list. On a token page the row is read as a
    // movement of THAT token (same reasoning as `swapSide` above), so show the
    // scoped faucet's own total and nothing else: listing "+10 B" on token A's
    // page states a balance change that never touched A.
    const scopedExtra = tokenId ? entry.extraAmounts?.find(line => line.faucetId === tokenId) : undefined;
    if (scopedExtra) {
      // No amount means the faucet's decimals are unknown, so there is no honest
      // number to print — name the asset and leave the quantity out.
      amount =
        scopedExtra.amount === undefined
          ? { value: '', symbol: scopedExtra.token, direction: amountDirection }
          : { value: `${sign}${scopedExtra.amount}`, symbol: scopedExtra.token, direction: amountDirection };
    } else {
      const lines = tokenId ? [] : (entry.extraAmounts ?? []);
      // Promotion is keyed on the TOKEN, not the amount. A claim can name its
      // primary asset while having no number for it — either because the first
      // note's value was unknown (`ConsumeTransaction` leaves `amount` undefined
      // there) or because that faucet resolved only to the unknown-token
      // placeholder, whose decimals are a guess. In both cases the primary still
      // owns the headline: promoting a secondary over it would file the row
      // under faucet A while reading as a credit of B.
      //
      // Only a claim with no primary asset at all borrows one from the extras,
      // and then a quantified line is preferred — the headline is the row's one
      // prominent number, so an unquantified asset is a poor choice for it,
      // though still better than dropping every asset the claim collected.
      const [promoted, ...rest] =
        entry.token === undefined
          ? [...lines].sort((a, b) => Number(b.amount !== undefined) - Number(a.amount !== undefined))
          : [];
      const headlineValue = promoted ? promoted.amount : entry.amount?.toString();
      const headlineSymbol = promoted ? promoted.token : entry.token;

      // Nothing to state only when there is neither a primary asset nor an extra
      // to borrow; a named asset with no number is still worth a row.
      if (headlineSymbol !== undefined || headlineValue !== undefined) {
        const extra = (promoted ? rest : lines).map(line => ({
          key: line.faucetId,
          value: line.amount === undefined ? '' : `${sign}${line.amount}`,
          symbol: line.token
        }));
        amount = {
          // Empty when the scale is unknown — the sign would otherwise render
          // alone, as a bare "+" in front of the symbol.
          value: headlineValue === undefined ? '' : `${sign}${headlineValue}`,
          symbol: headlineSymbol,
          direction: amountDirection,
          extra: extra.length > 0 ? extra : undefined
        };
      }
    }
  }

  let statusTone: ActivityStatusTone = 'confirmed';
  let statusLabel = t('confirmed');
  if (isCancelled) {
    statusTone = 'cancelled';
    statusLabel = t('cancelled');
  } else if (isFailed) {
    statusTone = 'failed';
    statusLabel = t('failed');
  } else if (
    entry.type === HistoryEntryType.PendingTransaction ||
    entry.type === HistoryEntryType.ProcessingTransaction
  ) {
    statusTone = 'pending';
    statusLabel = t('pending');
  } else if (entry.txType === 'earn-deposit' && earnDepositSettlementOf(entry) !== 'confirmed') {
    // A deposit row completes when the Miden collateral note lands, but the
    // position only exists once the solver-fulfilled Sepolia lending leg settles —
    // the chip tracks that leg (mirrors `EarnDepositStatusPill` on the details
    // page). Deliberately checked AFTER cancelled/failed/pending so a Miden-side
    // failure always wins over the lending leg's state.
    const settlement = earnDepositSettlementOf(entry);
    statusTone = settlement;
    statusLabel = t(EARN_DEPOSIT_STATUS_LABEL_KEY[settlement]);
  } else if (isSwap && entry.swapSettlement === 'pending') {
    // A completed swap row is the single trace of the whole order (its
    // settlement consumes are suppressed) — the chip reflects settlement.
    statusTone = 'pending';
    statusLabel = t('pending');
  } else if (isSwap && entry.swapSettlement === 'reclaimed') {
    statusTone = 'cancelled';
    statusLabel = t('reclaimed');
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
  ({
    entries,
    initialLoading,
    loadMore,
    hasMore,
    scrollParentRef,
    tokenId,
    fullHistory,
    centerEmptyState,
    className
  }) => {
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
      <div data-testid="history-view" className="flex flex-col">
        {dateGroups.map(([dateMs, dateEntries], index) => (
          <div
            key={dateMs}
            className={classNames('flex flex-col gap-1 py-3 border-b-[#BABABA33] border-b', index === 0 && 'pt-4')}
          >
            <DateSeparator dateMs={dateMs} />
            <div className="flex flex-col divide-y divide-rule-default dark:divide-pure-white">
              {dateEntries.map(entry => {
                const props = buildRowProps(entry, t, tokenId);
                return (
                  <ActivityRow
                    key={entry.key}
                    entryKey={entry.key}
                    testId="activity-row"
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
