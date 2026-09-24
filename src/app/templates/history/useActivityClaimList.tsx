import React, { useCallback, useMemo, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { useActivityClaims } from 'app/hooks/useActivityClaims';
import { useActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import type { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import { useConfirm } from 'lib/ui/dialog';

import type { ActivityFilter } from './History';
import { PendingActivityCard, type PendingActivityItem } from './PendingActivityCard';

function isShown(item: PendingActivityItem, hiddenIds: ReadonlySet<string>): boolean {
  if (item.status === 'checking' || item.status === 'unavailable') return false;
  return !hiddenIds.has(item.note.id) || item.status === 'claimed' || item.status === 'claiming';
}

/**
 * The incoming transfers the Activity tab lists as claim cards, and the renderer for them. Both the List
 * and the Groups view read it, so a transfer can be accepted or declined from either and each hands the
 * same items to `History`, which hides the consume row a card already stands for.
 */
export function useActivityClaimList(search: string, filter: ActivityFilter) {
  const { t } = useTranslation();
  const { items, accept, acceptMany, account, isLoadingNotes } = useActivityClaims();
  const hidden = useActivityHiddenNotes(account.publicKey);
  const confirm = useConfirm();
  const currentItems = useRef(items);
  currentItems.current = items;

  const query = search.trim().toLowerCase();
  // Memoized with the card renderer below, so a render that changes no pending item keeps
  // History's props identical and the timeline does not re-render.
  // Unsearched: History hides the consume row of each of these, and a search that drops a card
  // must not bring that row back.
  const representedItems = useMemo(
    () =>
      items.filter(item => {
        if (!isShown(item, hidden.ids)) return false;
        if (filter === 'sent' || filter === 'faucet') return false;
        return !(filter === 'pending' && item.status === 'claimed');
      }),
    [items, hidden.ids, filter]
  );
  // The cards drawn.
  const listItems = useMemo(
    () =>
      query
        ? representedItems.filter(item =>
            [item.note.metadata.symbol, item.note.metadata.name, item.note.senderAddress].some(value =>
              value?.toLowerCase().includes(query)
            )
          )
        : representedItems,
    [representedItems, query]
  );

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

  return { items, representedItems, listItems, renderPendingItem, acceptMany, account, isLoadingNotes, hidden };
}
