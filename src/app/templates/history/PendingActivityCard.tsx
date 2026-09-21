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

// One card per incoming transfer that is still waiting on a decision.
//
// The header row is a toggle that folds the detail rows and the hint line, and the footer carries
// Decline and Accept. The disclosure exists FOR that decision: it is what you read before
// accepting or declining.
//
// It has no accepted state. Once a transfer is accepted there is nothing left to decide, so it
// stops being a card of its own and becomes an ordinary row in the Activity feed, drawn by the
// same component as every other settled transaction and carrying that component's own navigation
// to the transaction page. `ActivityPendingHistory` drops a `claimed` item from the card list and
// `History` stops standing its consume row down, so the two swap cleanly with nothing in between.
export const PendingActivityCard = ({ item, onAccept, onReject }: PendingActivityCardProps) => {
  const { t } = useTranslation();
  const { note, status } = item;
  const transition = useMotion(springs.standard);
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const sender = note.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown');
  const amount = hasKnownScale(note.metadata) ? formatBigInt(BigInt(note.amount), note.metadata.decimals) : undefined;
  const amountLabel = amount === undefined ? note.metadata.symbol : `${amount} ${note.metadata.symbol}`;
  // A note served from the cache waits for the live read before it can be accepted.
  const canAccept = (status === 'pending' || status === 'failed') && note.fromCache !== true;
  const busy = status === 'claiming' || status === 'checking';

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
      status="pending"
    />
  );

  return (
    <Card asChild surface="outline" padding="none">
      <article className="flex flex-col overflow-hidden" data-pending-status={status}>
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

        <AnimatePresence initial={false}>
          {expanded && (
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
                {note.recallableAtMs !== undefined && (
                  <p className="mt-1 text-xs text-text-secondary-token">
                    {t('noteReturnsToSenderBy', { date: new Date(note.recallableAtMs).toLocaleString() })}
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* The actions are ordinary design-system buttons: the app's pill, at the app's size, with
            the card's own padding around them. `className` here sets width only; nothing restyles
            a Button from the call site.
            The row's layout is STATIC: Decline takes 40%, Accept the rest, and a button is either
            there or it is not. The previous footer expanded Decline from 0 to 40% through an
            `AnimatePresence` with `initial={false}` — which only suppresses the entry animation
            for what is present when that `AnimatePresence` FIRST mounts. Switching the Activity
            filter renders a different list, so every card remounted and the width tween replayed
            from zero on each tab change, reflowing the whole footer. */}
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
      </article>
    </Card>
  );
};
