import { useEffect, useState } from 'react';

import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import * as Repo from 'lib/miden/repo';
import { canonicalWalletAccountId, sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { WalletContact } from 'lib/shared/types';
import { detectAddressChain } from 'utils/miden';

import { recipientOf } from './useRecentRecipients';

/**
 * One key per recipient whatever form it is typed in. A Miden address drops its routing suffix and
 * form through `canonicalWalletAccountId`; a `0x` address is compared trimmed and lowercased, since
 * `canonicalWalletAccountId` would fall back to its raw, case-sensitive text.
 */
export function recipientKey(address: string): string {
  return detectAddressChain(address) === 'ethereum'
    ? address.trim().toLowerCase()
    : canonicalWalletAccountId(address.trim());
}

export function isNewRecipient({
  to,
  accountId,
  rows,
  contacts
}: {
  to: string;
  accountId: string;
  rows: readonly ITransaction[];
  contacts: readonly WalletContact[];
}): boolean {
  if (!to.trim()) return false;
  const key = recipientKey(to);
  if (contacts.some(contact => recipientKey(contact.address) === key)) return false;

  return !rows.some(row => {
    if (row.restoredFromBackup || row.status === ITransactionStatus.Failed) return false;
    if (!sameWalletAccountId(row.accountId, accountId)) return false;
    const recipient = recipientOf(row);
    return recipient !== undefined && recipientKey(recipient.address) === key;
  });
}

interface HistoryRead {
  accountId: string;
  key: string;
  rows: ITransaction[];
}

/**
 * Whether this account has never sent to `to`: the cue for the "New recipient" tag on the send review.
 * `undefined` while the history is unread (or when it cannot be read), so the tag never flashes and Send
 * is never held up.
 *
 * The history is read once per recipient, not live: submitting writes a Queued row for this very
 * recipient while the review is still mounted, and a live query would drop the tag as the user taps Send.
 */
export function useIsNewRecipient(accountId: string | null | undefined, to: string): boolean | undefined {
  const { allContacts } = useFilteredContacts();
  const [read, setRead] = useState<HistoryRead>();
  const key = to.trim() ? recipientKey(to) : '';

  useEffect(() => {
    if (!accountId || !key) return;
    let cancelled = false;
    Repo.transactions
      .filter(row => (row.type === 'send' || row.type === 'bridged-send') && !row.restoredFromBackup)
      .toArray()
      .then(rows => {
        if (!cancelled) setRead({ accountId, key, rows });
      })
      .catch(err => console.warn('[useIsNewRecipient] history read failed', err));
    return () => {
      cancelled = true;
    };
  }, [accountId, key]);

  if (!accountId || !key || read?.accountId !== accountId || read.key !== key) return undefined;
  return isNewRecipient({ to, accountId, rows: read.rows, contacts: allContacts });
}
