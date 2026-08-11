import { useEffect, useState } from 'react';

import { liveQuery } from 'dexie';

import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IBridgedSendExtraInputs, ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { detectAddressChain } from 'utils/miden';

import { BRIDGE_NETWORKS } from './bridge-networks';
import { RecentRecipient } from './types';

/** How many distinct recipients the "Recent" list shows. */
const MAX_RECENT_RECIPIENTS = 5;

const EMPTY_RECENTS: RecentRecipient[] = [];

/**
 * The recipient of a stored send row. Same-chain sends keep it in
 * `secondaryAccountId`; a cross-chain send is a separate `bridged-send` row
 * whose `secondaryAccountId` is the bridge allocator, so the user-facing
 * recipient comes from `extraInputs.destinationAddress` instead.
 */
const recipientOf = (row: ITransaction): { address: string; networkName?: string } | undefined => {
  if (row.type === 'send') {
    const address = row.secondaryAccountId?.trim();
    return address ? { address } : undefined;
  }

  if (row.type === 'bridged-send') {
    const extraInputs: IBridgedSendExtraInputs | undefined = row.extraInputs;
    const address = extraInputs?.destinationAddress?.trim();
    if (!address) return undefined;
    // Only a numeric chain id is stored, so resolve it back to a display name.
    const network = BRIDGE_NETWORKS.find(n => n.chainId === extraInputs?.destinationNetwork);
    return { address, networkName: network?.name };
  }

  return undefined;
};

/** Newest first; a queued row has no `completedAt` yet, so fall back to `initiatedAt`. */
const orderingTime = (row: ITransaction): number => row.completedAt ?? row.initiatedAt;

export const selectRecentRecipients = (rows: ITransaction[], accountId: string): RecentRecipient[] => {
  const ordered = rows
    .filter(row => compareAccountIds(row.accountId, accountId))
    .sort((a, b) => orderingTime(b) - orderingTime(a));

  const seen = new Set<string>();
  const recents: RecentRecipient[] = [];

  for (const row of ordered) {
    const recipient = recipientOf(row);
    if (!recipient) continue;

    const key = recipient.address.toLowerCase();
    // Sending to yourself is blocked at entry, but a legacy row shouldn't
    // resurface the account's own address as a suggestion.
    if (seen.has(key) || compareAccountIds(recipient.address, accountId) || key === accountId.toLowerCase()) continue;

    seen.add(key);
    recents.push({
      address: recipient.address,
      chain: detectAddressChain(recipient.address),
      networkName: recipient.networkName
    });

    if (recents.length === MAX_RECENT_RECIPIENTS) break;
  }

  return recents;
};

/**
 * The current account's most recent distinct send recipients, newest first.
 *
 * Backed by a Dexie `liveQuery` (push, like `useTransactionRow`) so the list
 * refreshes as soon as a send is queued, without polling. Account scoping goes
 * through `compareAccountIds` rather than the `accountId` index because stored
 * ids may carry a note-tag suffix.
 */
export const useRecentRecipients = (accountId: string | null | undefined): RecentRecipient[] => {
  const [recents, setRecents] = useState<RecentRecipient[]>(EMPTY_RECENTS);

  useEffect(() => {
    if (!accountId) {
      setRecents(EMPTY_RECENTS);
      return;
    }

    const subscription = liveQuery(() =>
      Repo.transactions.filter(row => row.type === 'send' || row.type === 'bridged-send').toArray()
    ).subscribe({
      next: rows => setRecents(selectRecentRecipients(rows, accountId)),
      error: () => setRecents(EMPTY_RECENTS)
    });

    return () => subscription.unsubscribe();
  }, [accountId]);

  return recents;
};
