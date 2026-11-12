import { useEffect, useMemo, useState } from 'react';

import { compareAccountIds } from 'lib/miden/activity/utils';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import * as Repo from 'lib/miden/repo';
import { canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
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

/**
 * The keys of every recipient this account has sent to, from its non-failed `send` and `bridged-send`
 * rows; a row restored from a backup file never counts. The account is matched on its address part, as
 * the Recent list matches it, so no row costs an SDK parse until it is this account's.
 */
function knownRecipientKeys(rows: readonly ITransaction[], accountId: string): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.restoredFromBackup || row.status === ITransactionStatus.Failed) continue;
    if (!compareAccountIds(row.accountId, accountId)) continue;
    const recipient = recipientOf(row);
    if (recipient) keys.add(recipientKey(recipient.address));
  }
  return keys;
}

const isUnknown = (key: string, known: ReadonlySet<string>, contacts: readonly WalletContact[]): boolean =>
  !known.has(key) && !contacts.some(contact => recipientKey(contact.address) === key);

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
  return !!to.trim() && isUnknown(recipientKey(to), knownRecipientKeys(rows, accountId), contacts);
}

interface HistoryRead {
  accountId: string;
  key: string;
  known: ReadonlySet<string>;
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
      .where('type')
      .anyOf('send', 'bridged-send')
      .toArray()
      .then(rows => {
        if (!cancelled) setRead({ accountId, key, known: knownRecipientKeys(rows, accountId) });
      })
      .catch(err => console.warn('[useIsNewRecipient] history read failed', err));
    return () => {
      cancelled = true;
    };
  }, [accountId, key]);

  const current = accountId && key && read?.accountId === accountId && read.key === key ? read : undefined;
  return useMemo(
    () => (current ? isUnknown(current.key, current.known, allContacts) : undefined),
    [current, allContacts]
  );
}
