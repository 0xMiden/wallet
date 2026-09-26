import React, { useMemo, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { usdFormatterFor } from 'lib/i18n/numbers';
import { markActivityRead } from 'lib/settings/activity-read';
import { useWalletStore } from 'lib/store';
import { getPendingNotesUsdTotal } from 'lib/wallet-prompts';

import { ClaimsLoadingBar } from './ActivityClaimsStatus';
import { pendingNoteUnreadKey } from './activityUnread';
import History, { ActivityFilter } from './History';
import { useActivityClaimList } from './useActivityClaimList';

interface ActivityPendingHistoryProps {
  search: string;
  filter: ActivityFilter;
  programId?: string | null;
  /** Forwarded to the list below, which owns the loading state the caller reports on. */
  onInitialLoad?: () => void;
}

export const ActivityPendingHistory = ({ search, filter, programId, onInitialLoad }: ActivityPendingHistoryProps) => {
  const { t } = useTranslation();
  const { representedItems, listItems, renderPendingItem, acceptMany, account, isLoadingNotes, hidden, hiddenCount } =
    useActivityClaimList(search, filter);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Accept All takes every listed transfer that can be accepted - whatever the asset, whoever
  // sent it. It is the ONE bulk action on this tab; there is no per-asset or per-sender variant.
  const claimableNotes = listItems
    .filter(item => (item.status === 'pending' || item.status === 'failed') && item.note.fromCache !== true)
    .map(item => item.note);
  const claimingCount = listItems.filter(item => item.status === 'claiming').length;
  // Every acceptable transfer is already in flight: the action stays, in its loading state, so it
  // does not vanish from under the tap that started it.
  const acceptingAll = claimingCount > 0 && claimableNotes.length === 0;
  const showAcceptAll = filter === 'pending' && (claimableNotes.length > 0 || acceptingAll);
  // Restore is offered only while a declined transfer could still be accepted.
  const showRestore = filter === 'pending' && hiddenCount > 0;
  // What the row's left side says. The money is the whole point of the row - it is what Accept
  // All is about to accept - so it is read off the SAME list the cards below come from, which is
  // `isShown`'s, and a declined transfer is not on it. `HomePrompts` reads the same set through
  // the same store, which is what makes the banner and this row agree.
  const waitingTotalUsd = useMemo(
    () =>
      getPendingNotesUsdTotal(
        listItems.map(item => item.note),
        tokenPrices
      ),
    [listItems, tokenPrices]
  );
  // Pinned to the total's own precision, so a figure travelling towards a dust total does not
  // change width on the way (`AnimatedNumber`).
  const formatWaitingTotal = useMemo(() => usdFormatterFor(waitingTotalUsd ?? 0), [waitingTotalUsd]);
  // One line, one lockup, the same one the home banner uses for this money: the count in the
  // caption style, the total as a value on `ink`. When transfers are also hidden that fact joins
  // the SAME sentence as a clause rather than becoming a second line - and it is the clause the
  // truncation eats first, so the figure survives a 360px row. With nothing waiting at all there
  // is no money to report and the hidden count takes the slot on its own.
  const waitingCount = listItems.length;
  const summary =
    waitingCount === 0
      ? t('activityHiddenTransfers', { count: hiddenCount })
      : hiddenCount > 0
        ? t('activityPendingWaitingHidden', { count: waitingCount, hidden: hiddenCount })
        : t('activityPendingWaiting', { count: waitingCount });

  // Accepting everything listed: reading them all, then the one batch-claim path. The Accept All
  // button in the row beside Restore is its only caller.
  const acceptAll = () => {
    for (const note of claimableNotes) {
      markActivityRead(pendingNoteUnreadKey(note.id), note.receivedAt ?? Number.NaN);
    }
    acceptMany(claimableNotes);
  };

  return (
    <>
      <ClaimsLoadingBar loading={isLoadingNotes} />

      {/* `pb-28` clears the floating navbar. There is no pinned footer any more: Accept All sits
          in the row below, so the tab keeps its navbar the way every other tab does. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pb-28">
        {hidden.failed && (
          <p role="alert" className="px-4 py-2 text-xs text-status-negative">
            {t('activityHiddenNotesError')}
          </p>
        )}
        {(showRestore || showAcceptAll) && (
          // One actions row above the list: what is waiting on the left, the actions on the
          // right. The left side is never empty - Accept All only appears while something is
          // listed - so the button is never an orphan floating against a band of empty space.
          <div className="flex items-center gap-2 px-4 pt-3">
            {/* The summary gives up its width first, so two buttons beside it cannot wrap the
                row on a 360px phone; the figure and the labels themselves never break. */}
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="min-w-0 truncate text-caption text-muted">{summary}</span>
              {waitingCount > 0 && (
                <AnimatedNumber
                  data-testid="pending-row-total"
                  className="shrink-0 text-value text-ink"
                  // An asset with no price leaves no total (null), and neither is a total of zero:
                  // say nothing rather than put a false figure next to the button that accepts them.
                  value={waitingTotalUsd !== null && waitingTotalUsd > 0 ? waitingTotalUsd : null}
                  format={formatWaitingTotal}
                />
              )}
            </div>
            {showRestore && (
              <Button
                variant={ButtonVariant.Secondary}
                size="sm"
                className="w-auto shrink-0"
                title={t('activityRestoreTransfers')}
                onClick={() => hidden.restore()}
              />
            )}
            {showAcceptAll && (
              <Button
                size="sm"
                className="w-auto shrink-0"
                data-testid="pending-row-accept-all"
                title={acceptingAll ? t('claiming') : t('acceptAll')}
                disabled={claimableNotes.length === 0 && !acceptingAll}
                isLoading={acceptingAll}
                onClick={() => acceptAll()}
              />
            )}
          </div>
        )}
        <div className="px-4">
          <History
            address={account.publicKey}
            programId={programId}
            fullHistory
            centerEmptyState
            scrollParentRef={scrollRef}
            searchQuery={search}
            filter={filter}
            pendingItems={representedItems}
            drawnPendingItems={listItems}
            renderPendingItem={renderPendingItem}
            onInitialLoad={onInitialLoad}
          />
        </div>
      </div>
    </>
  );
};
