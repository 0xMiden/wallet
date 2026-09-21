import React, { useCallback, useMemo, useRef } from 'react';

import classNames from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useActivityClaims } from 'app/hooks/useActivityClaims';
import { useActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import type { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import { Button, ButtonVariant } from 'components/Button';
import { durations, useMotion } from 'lib/animation';
import { markActivityRead } from 'lib/settings/activity-read';
import { useConfirm } from 'lib/ui/dialog';

import { pendingNoteUnreadKey } from './activityUnread';
import History, { ActivityFilter } from './History';
import { PendingActivityCard, type PendingActivityItem } from './PendingActivityCard';

interface ActivityPendingHistoryProps {
  search: string;
  filter: ActivityFilter;
  programId?: string | null;
}

function isShown(item: PendingActivityItem, hiddenIds: ReadonlySet<string>): boolean {
  if (item.status === 'checking' || item.status === 'unavailable') return false;
  // An accepted transfer is no longer a card at all: `History` stops standing its consume row
  // down once the claim settles, so it appears in the feed as the ordinary transaction it now is.
  if (item.status === 'claimed') return false;
  return !hiddenIds.has(item.note.id) || item.status === 'claiming';
}

export const ActivityPendingHistory = ({ search, filter, programId }: ActivityPendingHistoryProps) => {
  const { t } = useTranslation();
  const { items, accept, acceptMany, account, isLoadingNotes } = useActivityClaims();
  const reducedMotion = useReducedMotion();
  const loadingTransition = useMotion({
    duration: durations.extraSlow * 2,
    ease: 'linear',
    repeat: reducedMotion ? 0 : Infinity
  });
  const hidden = useActivityHiddenNotes(account.publicKey);
  const confirm = useConfirm();
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentItems = useRef(items);
  currentItems.current = items;

  const query = search.trim().toLowerCase();
  // Memoized with the card renderer below, so a render that changes no pending item keeps
  // History's props identical and the timeline does not re-render.
  const listItems = useMemo(
    () =>
      items.filter(item => {
        if (!isShown(item, hidden.ids)) return false;
        if (filter === 'sent' || filter === 'faucet') return false;
        return (
          !query ||
          [item.note.metadata.symbol, item.note.metadata.name, item.note.senderAddress].some(value =>
            value?.toLowerCase().includes(query)
          )
        );
      }),
    [items, hidden.ids, filter, query]
  );
  // Declined transfers that could still be accepted. The Decline dialog promises they can be
  // brought back, so the Pending filter offers Restore while any exist.
  const hiddenCount = items.filter(
    item => hidden.ids.has(item.note.id) && (item.status === 'pending' || item.status === 'failed')
  ).length;
  // Accept All takes every listed transfer that can be accepted — whatever the asset, whoever
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

  const reject = async (note: NoteWithMetadata) => {
    const accepted = await confirm({
      title: t('activityRejectTransfer'),
      children: t('activityRejectExplanation'),
      confirmLabel: t('activityRejectTransfer'),
      destructive: true
    });
    if (!accepted) return;
    const latest = currentItems.current.find(item => item.note.id === note.id);
    if (!latest || (latest.status !== 'pending' && latest.status !== 'failed')) return;
    await hidden.hide(note.id);
    // Declining settles the transfer as surely as accepting it does. Only here, not at the tap:
    // a decline the user backed out of is no decision at all.
    markActivityRead(pendingNoteUnreadKey(note.id), note.receivedAt ?? Number.NaN);
  };
  // Accepting everything listed: reading them all, then the one batch-claim path. Both the row
  // beside Restore and the pinned CTA call this, so there is one definition of "Accept All".
  const acceptAll = () => {
    for (const note of claimableNotes) {
      markActivityRead(pendingNoteUnreadKey(note.id), note.receivedAt ?? Number.NaN);
    }
    acceptMany(claimableNotes);
  };
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const rejectRef = useRef(reject);
  rejectRef.current = reject;
  const hiddenLoaded = hidden.loaded;
  const renderPendingItem = useCallback(
    (item: PendingActivityItem) => (
      <PendingActivityCard
        item={item}
        onAccept={note => acceptRef.current(note)}
        onReject={hiddenLoaded ? note => rejectRef.current(note) : undefined}
      />
    ),
    [hiddenLoaded]
  );

  return (
    <>
      <div className="mx-4 h-0.5 shrink-0 overflow-hidden rounded-full">
        {isLoadingNotes && (
          <motion.div
            role="progressbar"
            aria-label={t('loading')}
            className={reducedMotion ? 'h-full w-full bg-accent-primary' : 'h-full w-1/3 bg-accent-primary'}
            initial={false}
            animate={{ x: reducedMotion ? '0%' : ['-100%', '300%'] }}
            transition={loadingTransition}
          />
        )}
      </div>

      {/* `pb-28` clears the floating navbar. There is no pinned footer any more: Accept All sits
          in the row below, so the tab keeps its navbar the way every other tab does. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pb-28">
        {hidden.failed && (
          <p role="alert" className="px-4 py-2 text-xs text-status-negative">
            {t('activityHiddenNotesError')}
          </p>
        )}
        {(showRestore || showAcceptAll) && (
          // One actions row above the list, carrying whichever of the two actions applies. With
          // no declined transfers it holds Accept All alone, pushed to the same right edge
          // Restore would have sat on, so the row does not change shape when Restore appears.
          <div className="flex items-center gap-2 px-4 pt-3 text-xs text-text-secondary-token">
            {showRestore && (
              <>
                {/* The count gives up its width first, so two buttons beside it cannot wrap the
                    row on a 360px phone; the labels themselves never break. */}
                <span className="min-w-0 flex-1 truncate">{t('activityHiddenTransfers', { count: hiddenCount })}</span>
                <Button
                  variant={ButtonVariant.Secondary}
                  size="sm"
                  className="w-auto shrink-0"
                  title={t('activityRestoreTransfers')}
                  onClick={() => hidden.restore()}
                />
              </>
            )}
            {showAcceptAll && (
              <Button
                size="sm"
                className={classNames('w-auto shrink-0', !showRestore && 'ml-auto')}
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
            pendingItems={listItems}
            renderPendingItem={renderPendingItem}
          />
        </div>
      </div>
    </>
  );
};
