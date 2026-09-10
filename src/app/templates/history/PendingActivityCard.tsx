import React, { useId, useState } from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import type { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import { Button, ButtonVariant } from 'components/Button';
import { Loader } from 'components/Loader';
import { ActivityRow } from 'components/ui/ActivityRow';
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
  replaceHistoryRow?: boolean;
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

// One card per incoming note. The header row is a toggle that folds the
// detail rows and the hint line, for every status. The action footer stays
// visible: Decline and Accept for an open note, Details for a claimed one.
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
      actionLabel = t('claiming');
      break;
    case 'failed':
      actionLabel = t('retry');
      break;
    case 'unavailable':
      actionLabel = t('noteUnavailable');
      break;
  }

  let hint = t('activityNotYetAccepted');
  let hintTone = 'text-text-secondary-token';
  switch (status) {
    case 'claimed':
      hint = t('activityTransferAccepted');
      break;
    case 'failed':
      hint = t('noteClaimFailedRetry');
      hintTone = 'text-status-negative';
      break;
  }

  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'from', label: t('from'), value: sender },
    { key: 'amount', label: t('amount'), value: amountLabel }
  ];
  if (note.receivedAt !== undefined) {
    rows.push({ key: 'received', label: t('activityReceivedOn'), value: formatDateTime(note.receivedAt) });
  }
  if (claimed && item.claimedAt !== undefined) {
    rows.push({ key: 'claimed', label: t('activityClaimedOn'), value: formatDateTime(item.claimedAt) });
  }

  return (
    <article
      className="flex flex-col overflow-hidden rounded-2xl border border-rule-default bg-white"
      data-pending-status={status}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 text-left focus-visible:outline-accent-primary"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => {
          hapticLight();
          setExpanded(value => !value);
        }}
      >
        <ActivityRow
          testId="pending-activity-row"
          entryKey={note.id}
          className="min-w-0 flex-1"
          icon={<Icon name={IconName.Receive} size="sm" className="[&_path]:fill-pure-white" />}
          iconBg="bg-tx-received"
          title={t('received')}
          subtitle={`${t('from')}: ${sender}`}
          amount={{
            value: amount === undefined ? '' : `+${amount}`,
            symbol: note.metadata.symbol,
            direction: 'positive'
          }}
          status={{
            label: claimed ? t('activityTransferClaimed') : t('pending'),
            tone: claimed ? 'confirmed' : 'pending'
          }}
        />
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
            <dl className="border-t border-rule-default divide-y divide-rule-default text-sm">
              {rows.map(row => (
                <div key={row.key} className="flex items-center justify-between gap-3 px-3 py-3">
                  <dt className="text-text-secondary-token">{row.label}</dt>
                  <dd className="min-w-0 truncate text-right font-heading font-bold text-text-primary-token">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>

            <div className={classNames('bg-gray-25 px-4 py-3 text-center text-sm italic', hintTone)}>
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

      {claimed ? (
        txId && (
          <Button
            className="w-full max-w-none rounded-none! h-12 min-h-12 border-t border-rule-default text-sm"
            variant={ButtonVariant.Secondary}
            title={t('activityTransferDetails')}
            onClick={() => navigate(`/history-details/${encodeURIComponent(txId)}`)}
          />
        )
      ) : (
        <div className="flex overflow-hidden border-t border-rule-default">
          <AnimatePresence initial={false}>
            {onReject && status !== 'claiming' && (
              <motion.div
                key="reject"
                className="shrink-0 overflow-hidden"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: '40%', opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={transition}
              >
                <Button
                  variant={ButtonVariant.Secondary}
                  className="w-full max-w-none rounded-none! h-12 min-h-12 px-3 whitespace-nowrap text-sm"
                  title={t('activityRejectTransfer')}
                  disabled={!canAccept}
                  onClick={() => onReject(note)}
                />
              </motion.div>
            )}
          </AnimatePresence>
          <Button
            className={`flex-1 max-w-none rounded-none! h-12 min-h-12 px-3 text-sm ${status === 'claiming' ? 'bg-primary-500 text-pure-white' : ''}`}
            title={actionLabel}
            disabled={!canAccept}
            aria-label={actionLabel}
            aria-busy={busy}
            onClick={() => onAccept(note)}
          >
            <span className="relative flex h-5 w-full items-center justify-center">
              <AnimatePresence initial={false}>
                <motion.span
                  key={status === 'claiming' ? 'spinner' : 'label'}
                  className="absolute inset-0 flex items-center justify-center whitespace-nowrap"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={transition}
                  aria-hidden
                >
                  {status === 'claiming' ? <Loader color="white" /> : actionLabel}
                </motion.span>
              </AnimatePresence>
            </span>
          </Button>
        </div>
      )}
    </article>
  );
};
