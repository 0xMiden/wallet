import React, { useMemo, useRef } from 'react';

import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useActivityClaims } from 'app/hooks/useActivityClaims';
import { useActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import type { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import { Button, ButtonVariant } from 'components/Button';
import { durations, useMotion } from 'lib/animation';
import { useConfirm } from 'lib/ui/dialog';

import History, { ActivityFilter } from './History';
import { PendingActivityCard } from './PendingActivityCard';

interface ActivityPendingHistoryProps {
  search: string;
  filter: ActivityFilter;
  programId?: string | null;
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
  const maxFee = useNetworkFeeEstimate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentItems = useRef(items);
  currentItems.current = items;

  const shown = items.filter(item => {
    if (item.status === 'checking' || item.status === 'unavailable') return false;
    return !hidden.ids.has(item.note.id) || item.status === 'claimed' || item.status === 'claiming';
  });
  const query = search.trim().toLowerCase();
  const listItems = shown.filter(item => {
    if (filter === 'sent' || filter === 'faucet') return false;
    if (filter === 'pending' && item.status === 'claimed') return false;
    return (
      !query ||
      [item.note.metadata.symbol, item.note.metadata.name, item.note.senderAddress].some(value =>
        value?.toLowerCase().includes(query)
      )
    );
  });
  const pendingCount = shown.filter(item => item.status !== 'claimed').length;
  // Claim All on the Pending tab takes every listed note that can be accepted.
  const claimableNotes = listItems
    .filter(item => item.status === 'pending' || item.status === 'failed')
    .map(item => item.note);
  const claimingCount = listItems.filter(item => item.status === 'claiming').length;
  const excludedTransactions = useMemo(
    () =>
      items
        .filter(item => item.status === 'claimed' && item.replaceHistoryRow)
        .flatMap(item => (item.txId ? [item.txId] : [])),
    [items]
  );

  const reject = async (note: NoteWithMetadata) => {
    const accepted = await confirm({ title: t('activityRejectTransfer'), children: t('activityRejectExplanation') });
    if (!accepted) return;
    const latest = currentItems.current.find(item => item.note.id === note.id);
    if (!latest || (latest.status !== 'pending' && latest.status !== 'failed')) return;
    await hidden.hide(note.id);
  };

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

      {filter === 'pending' && pendingCount > 0 && (
        <div className="shrink-0 px-4 pt-3">
          <Button
            className="max-w-none"
            title={claimingCount > 0 && claimableNotes.length === 0 ? t('claiming') : t('claimAll')}
            disabled={claimableNotes.length === 0}
            isLoading={claimingCount > 0 && claimableNotes.length === 0}
            onClick={() => acceptMany(claimableNotes)}
          />
        </div>
      )}

      {pendingCount > 0 && maxFee && (
        <p className="shrink-0 px-4 pt-2 text-xs text-text-secondary-token">{t('activityClaimFee', { fee: maxFee })}</p>
      )}
      {hidden.ids.size > 0 && (
        <div className="shrink-0 px-4 flex items-center justify-between gap-2 text-xs text-text-secondary-token">
          <span>{t('activityRejectedHidden')}</span>
          <Button
            variant={ButtonVariant.Secondary}
            className="w-auto text-xs px-3 py-2"
            title={t('activityRestoreTransfers')}
            onClick={hidden.restore}
          />
        </div>
      )}
      {hidden.failed && (
        <p role="alert" className="px-4 py-2 text-xs text-status-negative">
          {t('activityHiddenNotesError')}
        </p>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pb-28">
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
            renderPendingItem={item => (
              <PendingActivityCard item={item} onAccept={accept} onReject={hidden.loaded ? reject : undefined} />
            )}
            excludeTransactionIds={excludedTransactions}
          />
        </div>
      </div>
    </>
  );
};
