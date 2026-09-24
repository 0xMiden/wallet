import React, { useRef } from 'react';

import classNames from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { durations, useMotion } from 'lib/animation';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { useLocation } from 'lib/woozie';

import History, { ActivityFilter } from './History';
import { useActivityClaimList } from './useActivityClaimList';

interface ActivityPendingHistoryProps {
  search: string;
  filter: ActivityFilter;
  programId?: string | null;
}

export const ActivityPendingHistory = ({ search, filter, programId }: ActivityPendingHistoryProps) => {
  const { t } = useTranslation();
  const { items, listItems, renderPendingItem, acceptMany, account, isLoadingNotes, hidden } = useActivityClaimList(
    search,
    filter
  );
  const reducedMotion = useReducedMotion();
  const loadingTransition = useMotion({
    duration: durations.extraSlow * 2,
    ease: 'linear',
    repeat: reducedMotion ? 0 : Infinity
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Declined transfers that could still be accepted. The Decline dialog promises they can be
  // brought back, so the Pending filter offers Restore while any exist.
  const hiddenCount = items.filter(
    item => hidden.ids.has(item.note.id) && (item.status === 'pending' || item.status === 'failed')
  ).length;
  // Claim All on the Pending tab takes every listed note that can be accepted.
  const claimableNotes = listItems
    .filter(item => (item.status === 'pending' || item.status === 'failed') && item.note.fromCache !== true)
    .map(item => item.note);
  const claimingCount = listItems.filter(item => item.status === 'claiming').length;
  // Accept All is the page's primary action, so it sits at the bottom edge in
  // place of the tab navbar, the way the send flow pins its CTA. It follows the
  // listed notes, search included, so a search that lists nothing gives the
  // navbar back. The navbar is hidden only while the Activity tab is the ACTIVE
  // route: TabLayout keeps a visited tab mounted under the others, so without the
  // route gate a pending list on a hidden Activity tab would hide the navbar on Home.
  const showAcceptAll = filter === 'pending' && listItems.length > 0;
  const { pathname } = useLocation();
  const onActivityTab = pathname.split('/')[1] === 'history';
  useHideNavbarWhileOpen(showAcceptAll && onActivityTab);

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

      {/* `pb-28` clears the floating navbar; with the Accept All footer in its
          place the list only needs its own bottom breathing room. */}
      <div ref={scrollRef} className={classNames('flex-1 min-h-0 overflow-y-auto', showAcceptAll ? 'pb-4' : 'pb-28')}>
        {hidden.failed && (
          <p role="alert" className="px-4 py-2 text-xs text-status-negative">
            {t('activityHiddenNotesError')}
          </p>
        )}
        {filter === 'pending' && hiddenCount > 0 && (
          <div className="flex items-center justify-between gap-2 px-4 pt-3 text-xs text-text-secondary-token">
            <span>{t('activityHiddenTransfers', { count: hiddenCount })}</span>
            <Button
              variant={ButtonVariant.Secondary}
              size="sm"
              className="w-auto"
              title={t('activityRestoreTransfers')}
              onClick={() => hidden.restore()}
            />
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

      {showAcceptAll && (
        <div className="shrink-0 px-4 pt-3 pb-4">
          <Button
            className="max-w-none"
            title={claimingCount > 0 && claimableNotes.length === 0 ? t('claiming') : t('acceptAll')}
            disabled={claimableNotes.length === 0}
            isLoading={claimingCount > 0 && claimableNotes.length === 0}
            onClick={() => acceptMany(claimableNotes)}
          />
        </div>
      )}
    </>
  );
};
