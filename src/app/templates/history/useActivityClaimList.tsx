import React, { useCallback, useMemo, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { useActivityClaims } from 'app/hooks/useActivityClaims';
import { useActivityHiddenNotes } from 'app/hooks/useActivityHiddenNotes';
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { markActivityRead } from 'lib/settings/activity-read';
import { useConfirm } from 'lib/ui/dialog';

import { hidesFaucetActivity, isFaucetClaimNote } from './activityGroups';
import { pendingNoteUnreadKey } from './activityUnread';
import type { ActivityFilter } from './History';
import { PendingActivityCard, type PendingActivityItem } from './PendingActivityCard';

/**
 * Whether a filter chip shows the claim cards. A claim card is an incoming transfer, so it shows
 * under the chips that list transfers, and under no other category.
 */
function showsClaimCards(filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all':
    case 'pending':
    case 'transfer':
      return true;
    case 'swap':
    case 'earn':
    case 'others':
      return false;
  }
}

function isShown(item: PendingActivityItem, hiddenIds: ReadonlySet<string>): boolean {
  if (item.status === 'checking' || item.status === 'unavailable') return false;
  // An accepted transfer is no longer a card at all: `History` stops standing its consume row
  // down once the claim settles, so it appears in the feed as the ordinary transaction it now is.
  if (item.status === 'claimed') return false;
  return !hiddenIds.has(item.note.id) || item.status === 'claiming';
}

/**
 * The incoming transfers the Activity tab lists as claim cards, and the renderer for them. Both the List
 * and the Groups view read it, so a transfer can be accepted or declined from either and each hands the
 * same items to `History`, which hides the consume row a card already stands for.
 */
export function useActivityClaimList(search: string, filter: ActivityFilter) {
  const { t } = useTranslation();
  const {
    items: claimItems,
    accept,
    acceptMany,
    retryHeld,
    cannotPayFee,
    account,
    isLoadingNotes
  } = useActivityClaims();
  // Read on each render: a Developer Settings save can change the network without a reload.
  const hideFaucet = hidesFaucetActivity(getEffectiveNetworkName());
  // Re-renders once the id hydrates or is discovered, so cards filtered while it was unknown are filtered again.
  const nativeFaucetId = useNativeFeeFaucetId();
  // On Mainnet a faucet claim is not a card, not a decline that Restore counts, and not a note
  // that Accept All takes, as `History` shows no faucet row there.
  const items = useMemo(
    () => (hideFaucet ? claimItems.filter(item => !isFaucetClaimNote(item.note, nativeFaucetId)) : claimItems),
    [claimItems, hideFaucet, nativeFaucetId]
  );
  const hidden = useActivityHiddenNotes(account.publicKey);
  const confirm = useConfirm();
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const currentItems = useRef(items);
  currentItems.current = items;

  const query = search.trim().toLowerCase();
  // Memoized with the card renderer below, so a render that changes no pending item keeps
  // History's props identical and the timeline does not re-render.
  // Unsearched: History hides the consume row of each of these, and a search that drops a card
  // must not bring that row back.
  const representedItems = useMemo(
    () => (showsClaimCards(filter) ? items.filter(item => isShown(item, hidden.ids)) : []),
    [items, hidden.ids, filter]
  );
  // The cards drawn.
  const listItems = useMemo(
    () =>
      query
        ? representedItems.filter(item =>
            [
              item.note.metadata.symbol,
              midenTokenLabel(bridgeConfig, item.note.faucetId, item.note.metadata.symbol),
              item.note.metadata.name,
              item.note.senderAddress
            ].some(value => value?.toLowerCase().includes(query))
          )
        : representedItems,
    [representedItems, query, bridgeConfig]
  );

  // Declined transfers that could still be accepted, which Restore brings back.
  const declinedItems = items.filter(
    item => hidden.ids.has(item.note.id) && (item.status === 'pending' || item.status === 'failed')
  );
  // What a Restore passes, so it brings back exactly the declines `hiddenCount` told the user about.
  const declinedIds = declinedItems.map(item => item.note.id);

  const reject = async (note: ClaimableNoteWithMetadata) => {
    const accepted = await confirm({
      title: t('activityRejectTransfer'),
      children: t('activityRejectExplanation'),
      confirmLabel: t('activityRejectTransfer'),
      destructive: true
    });
    if (!accepted) return;
    const latest = currentItems.current.find(item => item.note.id === note.id);
    if (!latest || (latest.status !== 'pending' && latest.status !== 'failed')) return;
    // Declining settles the transfer as surely as accepting it does. Only once the hide is stored,
    // not at the tap: a decline the user backed out of, or one whose write was rolled back, is no
    // decision at all.
    if (!(await hidden.hide(note.id))) return;
    markActivityRead(pendingNoteUnreadKey(note.id), note.receivedAt ?? Number.NaN);
  };
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const retryHeldRef = useRef(retryHeld);
  retryHeldRef.current = retryHeld;
  const rejectRef = useRef(reject);
  rejectRef.current = reject;
  const hiddenLoaded = hidden.loaded;
  const renderPendingItem = useCallback(
    (item: PendingActivityItem) => (
      <PendingActivityCard
        item={item}
        onAccept={note => acceptRef.current(note)}
        onReject={hiddenLoaded ? note => rejectRef.current(note) : undefined}
        onRetryHeld={heldItem => retryHeldRef.current(heldItem)}
      />
    ),
    [hiddenLoaded]
  );

  return {
    representedItems,
    listItems,
    renderPendingItem,
    acceptMany,
    cannotPayFee,
    account,
    isLoadingNotes,
    hidden,
    declinedItems,
    declinedIds,
    hiddenCount: declinedItems.length
  };
}
