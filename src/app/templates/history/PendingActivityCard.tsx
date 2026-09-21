import React, { useId, useState } from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import type { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import { Button, ButtonVariant } from 'components/Button';
import { ActivityRow } from 'components/ui/ActivityRow';
import { Card } from 'components/ui/Card';
import { springs, useMotion } from 'lib/animation';
import { formatBigInt } from 'lib/i18n/numbers';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

export type PendingActivityStatus = 'pending' | 'checking' | 'claiming' | 'claimed' | 'failed' | 'unavailable';

export interface PendingActivityItem {
  note: NoteWithMetadata;
  status: PendingActivityStatus;
  txId?: string;
  claimedAt?: number;
}

interface PendingActivityCardProps {
  item: PendingActivityItem;
  onAccept: (note: NoteWithMetadata) => void;
  onReject?: (note: NoteWithMetadata) => void;
}

function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// One card per incoming note.
//
// While the note is still open, the header row is a toggle that folds the detail rows and the
// hint line, and the footer carries Decline and Accept. The disclosure exists for that decision:
// it is what you read before accepting or declining.
//
// Once the note is claimed the decision is made and the card is just a received transaction, so
// the toggle, the chevron, the folded section and the whole action footer all go.
//
// The row itself then opens the transaction, the way every other settled row in this feed does.
// That is not decoration: while a claim is represented by one of these cards, `History` SUPPRESSES
// the real `consume` row it would otherwise duplicate, so until the tab is remounted this card is
// the only thing standing for that transaction. An inert row would leave `/history-details/:txId`
// unreachable for it for the rest of the session.
export const PendingActivityCard = ({ item, onAccept, onReject }: PendingActivityCardProps) => {
  const { t } = useTranslation();
  const { note, status, txId } = item;
  const transition = useMotion(springs.standard);
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const sender = note.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown');
  const amount = hasKnownScale(note.metadata) ? formatBigInt(BigInt(note.amount), note.metadata.decimals) : undefined;
  const amountLabel = amount === undefined ? note.metadata.symbol : `${amount} ${note.metadata.symbol}`;
  // A note served from the cache waits for the live read before it can be accepted.
  const canAccept = (status === 'pending' || status === 'failed') && note.fromCache !== true;
  const busy = status === 'claiming' || status === 'checking';
  const claimed = status === 'claimed';

  let actionLabel = t('activityAcceptTransfer');
  switch (status) {
    case 'checking':
      actionLabel = t('activityCheckingTransfer');
      break;
    case 'claiming':
      actionLabel = t('activityAcceptingTransfer');
      break;
    case 'failed':
      actionLabel = t('retry');
      break;
    case 'unavailable':
      actionLabel = t('noteUnavailable');
      break;
  }

  // The hint belongs to the folded section, which only an open note has.
  const hint = status === 'failed' ? t('noteClaimFailedRetry') : t('activityNotYetAccepted');
  const hintTone = status === 'failed' ? 'text-status-negative' : 'text-text-secondary-token';

  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'from', label: t('from'), value: sender },
    { key: 'amount', label: t('amount'), value: amountLabel }
  ];
  if (note.receivedAt !== undefined) {
    rows.push({ key: 'received', label: t('activityReceivedOn'), value: formatDateTime(note.receivedAt) });
  }

  // Whatever the status, the header row stays a real `button` — a disclosure toggle while the
  // note is open, the route to the transaction once it is claimed — so the row keeps an
  // accessible name from its own content and the card needs no label of its own.
  const openDetails = claimed && txId ? () => navigate(`/history-details/${encodeURIComponent(txId)}`) : undefined;

  const headerRow = (
    <ActivityRow
      testId="pending-activity-row"
      entryKey={note.id}
      className="min-w-0 flex-1 py-3"
      icon={<Icon name={IconName.Receive} size="sm" className="[&_path]:fill-pure-white" />}
      iconBg="bg-tx-received"
      title={t('received')}
      subtitle={`${t('from')}: ${sender}`}
      amount={{
        value: amount === undefined ? '' : `+${amount}`,
        symbol: note.metadata.symbol,
        direction: 'positive'
      }}
      status={claimed ? 'claimed' : 'pending'}
    />
  );

  return (
    <Card asChild surface="outline" padding="none" interactive={Boolean(openDetails)}>
      <article className="flex flex-col overflow-hidden" data-pending-status={status}>
        {claimed ? (
          // A real `button`, not a `div` with a click handler: the row has to answer Enter and
          // Space and take focus, like the Details action it replaces.
          <button
            type="button"
            className="flex w-full items-center px-4 text-left focus-visible:outline-accent-primary"
            disabled={!openDetails}
            onClick={() => {
              hapticLight();
              openDetails?.();
            }}
          >
            {headerRow}
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 text-left focus-visible:outline-accent-primary"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => {
              hapticLight();
              setExpanded(value => !value);
            }}
          >
            {headerRow}
            <motion.span
              aria-hidden
              className="flex h-6 w-6 shrink-0 items-center justify-center text-text-secondary-token"
              animate={{ rotate: expanded ? 180 : 0 }}
              transition={transition}
            >
              <Icon name={IconName.ChevronDown} size="sm" className="w-4! h-4!" fill="currentColor" />
            </motion.span>
          </button>
        )}

        <AnimatePresence initial={false}>
          {expanded && !claimed && (
            <motion.div
              id={detailsId}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={transition}
              className="overflow-hidden"
            >
              <dl className="border-t border-hairline divide-y divide-hairline text-sm">
                {rows.map(row => (
                  <div key={row.key} className="flex items-center justify-between gap-3 px-3 py-3">
                    <dt className="text-text-secondary-token">{row.label}</dt>
                    <dd className="min-w-0 truncate text-right font-heading font-bold text-text-primary-token">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className={classNames('bg-fill px-4 py-3 text-center text-sm italic', hintTone)}>
                <p role={status === 'failed' ? 'alert' : 'status'}>{hint}</p>
                {note.recallableAtMs !== undefined && !claimed && (
                  <p className="mt-1 text-xs text-text-secondary-token">
                    {t('noteReturnsToSenderBy', { date: new Date(note.recallableAtMs).toLocaleString() })}
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* A claimed transfer has no footer at all — no actions are left to take — so the card
            ends with its row rather than with a rule over an empty element.
            The open transfer's actions are ordinary design-system buttons: the app's pill, at the
            app's size, with the card's own padding around them. `className` here sets width only;
            nothing restyles a Button from the call site. */}
        {!claimed && (
          // The row's layout is STATIC: Decline takes 40%, Accept the rest, and a button is
          // either there or it is not. The previous footer expanded Decline from 0 to 40% through
          // an `AnimatePresence` with `initial={false}` — which only suppresses the entry
          // animation for what is present when that `AnimatePresence` FIRST mounts. Switching the
          // Activity filter renders a different list, so every card remounted and the width tween
          // replayed from zero on each tab change, reflowing the whole footer.
          <div className="flex gap-2.5 px-4 pb-4">
            {onReject && status !== 'claiming' && (
              <Button
                variant={ButtonVariant.Secondary}
                className="w-2/5 max-w-none whitespace-nowrap"
                title={t('activityRejectTransfer')}
                disabled={!canAccept}
                onClick={() => onReject(note)}
              />
            )}
            {/* A claim in flight is the Button's own loading state: the accent fill stays, the
                label is swapped for the spinner at the label's width and taps are refused. It is
                NOT `disabled`, which would grey the one action in progress. */}
            <Button
              className="min-w-0 flex-1 max-w-none"
              title={actionLabel}
              disabled={!canAccept && status !== 'claiming'}
              isLoading={status === 'claiming'}
              aria-busy={busy}
              onClick={() => onAccept(note)}
            />
          </div>
        )}
      </article>
    </Card>
  );
};
