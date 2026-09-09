import React, { useEffect, useId, useState } from 'react';

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

export const PendingActivityCard = ({ item, onAccept, onReject }: PendingActivityCardProps) => {
  const { t } = useTranslation();
  const { note, status, txId } = item;
  const transition = useMotion(springs.standard);
  const detailsId = useId();
  const [expanded, setExpanded] = useState(status === 'claimed');
  const sender = note.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown');
  const amount = hasKnownScale(note.metadata) ? formatBigInt(BigInt(note.amount), note.metadata.decimals) : undefined;
  const canAccept = status === 'pending' || status === 'failed';
  const busy = status === 'claiming' || status === 'checking';

  useEffect(() => {
    if (status === 'claimed') setExpanded(true);
  }, [status]);

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

  const header = (
    <ActivityRow
      testId="pending-activity-row"
      entryKey={note.id}
      className="px-3"
      icon={<Icon name={IconName.Receive} size="sm" className="[&_path]:fill-pure-white" />}
      iconBg="bg-tx-received"
      title={t('received')}
      subtitle={`${t('from')}: ${sender}`}
      amount={{ value: amount === undefined ? '' : `+${amount}`, symbol: note.metadata.symbol, direction: 'positive' }}
      status={{
        label: status === 'claimed' ? t('activityTransferClaimed') : t('pending'),
        tone: status === 'claimed' ? 'confirmed' : 'pending'
      }}
    />
  );

  return (
    <article
      className="flex flex-col overflow-hidden rounded-2xl border border-rule-default bg-white"
      data-pending-status={status}
    >
      {status === 'claimed' ? (
        <button
          type="button"
          className="block w-full text-left focus-visible:outline-accent-primary"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => {
            hapticLight();
            setExpanded(value => !value);
          }}
        >
          {header}
        </button>
      ) : (
        header
      )}

      {note.recallableAtMs !== undefined && status !== 'claimed' && (
        <p className="px-3 pb-3 text-xs text-text-secondary-token">
          {t('noteReturnsToSenderBy', { date: new Date(note.recallableAtMs).toLocaleString() })}
        </p>
      )}

      {status === 'failed' && (
        <p role="alert" className="px-3 pb-3 text-xs text-status-negative">
          {t('noteClaimFailedRetry')}
        </p>
      )}

      {status !== 'claimed' && (
        <div className="flex overflow-hidden">
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
                  className="w-full max-w-none rounded-none! h-11 min-h-11 px-3 whitespace-nowrap text-sm"
                  title={t('activityRejectTransfer')}
                  disabled={!canAccept}
                  onClick={() => onReject(note)}
                />
              </motion.div>
            )}
          </AnimatePresence>
          <Button
            className={`flex-1 max-w-none rounded-none! h-11 min-h-11 px-3 text-sm ${status === 'claiming' ? 'bg-primary-500 text-pure-white' : ''}`}
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

      <AnimatePresence initial={false}>
        {status === 'claimed' && expanded && (
          <motion.div
            id={detailsId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            className="overflow-hidden border-t border-rule-default"
          >
            <dl className="px-3 py-3 text-sm space-y-2">
              <div className="flex gap-3 justify-between">
                <dt className="text-text-secondary-token">{t('from')}</dt>
                <dd className="min-w-0 break-all text-right text-text-primary-token">{sender}</dd>
              </div>
              {item.claimedAt !== undefined && (
                <div className="flex gap-3 justify-between">
                  <dt className="text-text-secondary-token">{t('activityClaimedOn')}</dt>
                  <dd className="text-right text-text-primary-token">
                    {new Date(item.claimedAt * 1000).toLocaleString()}
                  </dd>
                </div>
              )}
            </dl>
            <p role="status" className="bg-gray-25 px-4 py-3 text-center text-sm text-text-secondary-token">
              {t('activityTransferAccepted')}
            </p>
            {txId && (
              <Button
                className="w-full rounded-none!"
                variant={ButtonVariant.Secondary}
                title={t('activityTransferDetails')}
                onClick={() => navigate(`/history-details/${encodeURIComponent(txId)}`)}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
};
