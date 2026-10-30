import React, { useEffect, useId, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { ActivityRow } from 'components/ui/ActivityRow';
import { Card } from 'components/ui/Card';
import { Notice } from 'components/ui/Notice';
import { UnreadDot } from 'components/ui/UnreadDot';
import { reducedMotionTransition, springs, useMotion, usePreset } from 'lib/animation';
import { formatBigInt } from 'lib/i18n/numbers';
import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import type { SubmissionFeedback } from 'lib/miden/transaction/submission-feedback';
import { hapticLight } from 'lib/mobile/haptics';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { isActivityRead, markActivityRead, useActivityReadState } from 'lib/settings/activity-read';
import type { UiEvidenceInput } from 'lib/telemetry/ui-producer-diagnostics';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { truncateAddress } from 'utils/string';

import { pendingNoteUnreadKey } from './activityUnread';

export type PendingActivityStatus = 'pending' | 'checking' | 'claiming' | 'claimed' | 'failed' | 'unavailable';

export interface PendingActivityItem {
  note: ClaimableNoteWithMetadata;
  status: PendingActivityStatus;
  txId?: string;
  claimedAt?: number;
  /** A claiming item whose row is Unconfirmed or Failed and still holds its notes: it offers its row's Retry, #1081. */
  held?: boolean;
  /** The refusal its last Retry met, shown in place of the hint. */
  retryError?: string;
  /** Stable for one producer failure, including when the note's details refresh. */
  failure?: { id: UserErrorId; diagnostics?: UiEvidenceInput };
  /** Accepting it is certain to fail on the network fee, so Accept is withheld and the card says why. */
  cannotPayFee?: boolean;
  /** Its claim is queued again because the Guardian is still settling the previous change, #1666. */
  guardianBusy?: true;
  /** A stored proof-submission outcome for this claim. Absent while the submit is still in progress. */
  submission?: SubmissionFeedback;
}

interface PendingActivityCardProps {
  item: PendingActivityItem;
  onAccept: (note: ClaimableNoteWithMetadata) => void;
  onReject?: (note: ClaimableNoteWithMetadata) => void;
  onRetryHeld?: (item: PendingActivityItem) => void;
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
export const PendingActivityCard = ({ item, onAccept, onReject, onRetryHeld }: PendingActivityCardProps) => {
  const { t } = useTranslation();
  const { note, status } = item;
  const transition = useMotion(springs.standard);
  const reveal = usePreset('reveal');
  const readState = useActivityReadState();
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  // An incoming transfer stays unread until it is accepted or declined, whichever comes first —
  // a decision, not a glance, is what settles it. `receivedAt` can be absent, and an unusable
  // timestamp never falls under the high-water mark, so such a note simply stays unread until
  // that decision is taken.
  const unreadKey = pendingNoteUnreadKey(note.id);
  const unread = !isActivityRead(readState, unreadKey, note.receivedAt ?? Number.NaN);
  const detailsId = useId();
  const feeNoticeId = useId();
  const [expanded, setExpanded] = useState(false);
  const sender = note.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown');
  const amount = hasKnownScale(note.metadata) ? formatBigInt(BigInt(note.amount), note.metadata.decimals) : undefined;
  const tokenLabel = midenTokenLabel(bridgeConfig, note.faucetId, note.metadata.symbol);
  const amountLabel = amount === undefined ? tokenLabel : `${amount} ${tokenLabel}`;
  // A note served from the cache waits for the live read before it can be accepted.
  const canAccept = (status === 'pending' || status === 'failed') && note.fromCache !== true;
  // Separate from `canAccept`: Decline costs no fee, so it stays.
  const feeBlocked = canAccept && item.cannotPayFee === true;
  const held = status === 'claiming' && item.held === true;
  const submission = item.retryError === undefined ? item.submission : undefined;
  // Retry runs only for a held claim (`onRetryHeld`). A claim still in flight keeps its spinner even
  // with a stored submit outcome, and the notice below explains it.
  const busy = (status === 'claiming' && !held) || status === 'checking';
  const waitingOnGuardian = status === 'claiming' && !held && item.guardianBusy === true && submission === undefined;
  // The section renders only after a tap, so it always moves on the preset except while a claim is
  // in flight: the status walks checking -> claiming -> gone, and a height tween across that is the
  // flicker. Read on every render, so a claim landing mid-tween drops the rest of it.
  const disclosureTransition = busy ? reducedMotionTransition : reveal.transition;

  let actionLabel = t('activityAcceptTransfer');
  switch (status) {
    case 'checking':
      actionLabel = t('activityCheckingTransfer');
      break;
    case 'claiming':
      actionLabel = held ? t('retry') : t('activityAcceptingTransfer');
      break;
    case 'failed':
      actionLabel = t('retry');
      break;
    case 'unavailable':
      actionLabel = t('noteUnavailable');
      break;
  }

  // The hint belongs to the folded section, which only an open note has. The tone carries the
  // failure; the words say it too, so the block is never colour alone.
  // A held claim awaits its verdict and may already have gone through, and its only action is Retry, so it says it
  // is not confirmed rather than inviting a review (#1081).
  // A stored submit outcome has its own notice outside the fold, so the hint never repeats it.
  const submissionText = submission !== undefined ? (submission.rowCopy ?? t(submission.messageKey)) : undefined;
  let hint = t('activityNotYetAccepted');
  if (item.retryError !== undefined) hint = item.retryError;
  else if (held) hint = t('transactionNotConfirmedHint');
  else if (status === 'failed' && submission?.kind !== 'guardianHold') hint = t('noteClaimFailedRetry');
  else if (waitingOnGuardian) hint = t('guardianBusyDescription');
  const negative =
    item.retryError !== undefined || (submission !== undefined ? submission.kind === 'rejected' : status === 'failed');
  const failureId =
    item.retryError !== undefined ? (item.failure?.id ?? null) : status === 'failed' ? 'noteClaimFailedRetry' : null;
  const [observedFailure, setObservedFailure] = useState<{
    noteId: string;
    status: PendingActivityStatus;
    failure: PendingActivityItem['failure'];
    errorId: UserErrorId | null;
  }>({ noteId: note.id, status, failure: item.failure, errorId: null });
  // A restored failure is a baseline; only a transition or a new producer failure is live on this mount.
  if (
    observedFailure.noteId !== note.id ||
    observedFailure.status !== status ||
    observedFailure.failure !== item.failure
  ) {
    setObservedFailure({
      noteId: note.id,
      status,
      failure: item.failure,
      errorId: observedFailure.noteId === note.id ? failureId : null
    });
  }

  const failureDiagnostics =
    observedFailure.failure?.diagnostics ??
    (observedFailure.errorId === 'noteClaimFailedRetry'
      ? ({
          kind: 'note_claim',
          noteClaimFailureOrigin: 'transaction_row',
          uiFailureKind: 'unavailable'
        } satisfies UiEvidenceInput)
      : undefined);

  // A refusal's message lives in the folded section, so it opens with it (#1081).
  useEffect(() => {
    if (item.retryError !== undefined) setExpanded(true);
  }, [item.retryError]);

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
      icon={<Icon name={IconName.Receive} size="sm" className="text-pure-white" />}
      iconBg="bg-tx-received"
      title={t('received')}
      subtitle={`${t('from')}: ${sender}`}
      amount={{
        value: amount === undefined ? '' : `+${amount}`,
        symbol: tokenLabel,
        direction: 'positive'
      }}
      status="pending"
    />
  );

  return (
    // The unread dot sits on the card's top-right corner, outside the card's own box: the card clips
    // its content to its rounded edge (`overflow-hidden`), which would cut the dot off. It is hidden
    // from assistive tech there; the header button carries the same label, so the card is still
    // announced as unread.
    <div className="relative">
      <span aria-hidden="true">
        <UnreadDot
          unread={unread}
          placement="corner"
          label={t('activityUnread')}
          className="z-1"
          data-testid="pending-activity-unread"
        />
      </span>
      <Card asChild surface="outline" padding="none">
        <article className="flex flex-col overflow-hidden" data-pending-status={status}>
          <button
            type="button"
            className="relative flex w-full items-center gap-2 px-4 text-left focus-visible:outline-accent-primary"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => {
              hapticLight();
              setExpanded(open => !open);
            }}
          >
            {unread && <span className="sr-only">{t('activityUnread')}</span>}
            {headerRow}
            {/* The only motion left on the card, and it cannot replay on a remount: `initial={false}`
              mounts the glyph at its `animate` value instead of tweening to it, and `expanded`
              starts false anyway, so a card rebuilt by a filter change draws an unrotated chevron
              with nothing in flight. It turns only in answer to a tap. */}
            <motion.span
              aria-hidden
              className="flex h-6 w-6 shrink-0 items-center justify-center text-text-secondary-token"
              initial={false}
              animate={{ rotate: expanded ? 180 : 0 }}
              transition={transition}
            >
              <Icon name={IconName.ChevronDown} size="sm" className="w-4! h-4!" fill="currentColor" />
            </motion.span>
          </button>

          {/* The disclosure unfolds and folds away on the design system's `reveal` preset, the one
            written for exactly this (height 0 <-> auto plus opacity, `springs.standard`), reduced-
            motion aware through `usePreset`, so no duration is spelled out here. A card rebuilt by
            a filter change mounts closed and renders no section, so there is nothing for an entry
            animation to act on. */}
          <AnimatePresence>
            {expanded && (
              <motion.div
                id={detailsId}
                initial={reveal.initial}
                animate={reveal.animate}
                exit={reveal.exit}
                transition={disclosureTransition}
                className="overflow-hidden"
              >
                <dl className="border-t border-hairline divide-y divide-hairline text-sm">
                  {rows.map(row => (
                    <div key={row.key} className="flex items-center justify-between gap-3 px-3 py-3">
                      <dt className="font-heading text-text-secondary-token">{row.label}</dt>
                      <dd className="min-w-0 truncate text-right font-heading font-bold text-text-primary-token">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {/* The shared inline explanation, not a hand-rolled grey band: one 13px size for
                both lines, the explanation in the tone's ink and the deadline under it in the
                quieter one, left-aligned and upright like every other block of copy in the app.
                It sits in the card's own margin with 12px above and below, so it no longer shares
                an edge with the buttons under it. */}
                <div className="px-4 py-3">
                  <Notice
                    errorId={observedFailure.errorId}
                    errorOccurrence={observedFailure.failure}
                    errorDiagnostics={failureDiagnostics}
                    data-testid="pending-activity-hint"
                    tone={negative ? 'negative' : 'neutral'}
                    role={negative ? 'alert' : 'status'}
                    title={hint}
                  >
                    {note.recallableAtMs === undefined
                      ? undefined
                      : t('noteReturnsToSenderBy', { date: new Date(note.recallableAtMs).toLocaleString() })}
                  </Notice>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Outside the fold, so a claim the Guardian holds back and a withheld Accept are never left without
            their reason. */}
          {waitingOnGuardian && (
            <div className="px-4 pb-3">
              <Notice variant="inline" tone="neutral" role="status" data-testid="pending-activity-guardian-wait">
                {t('guardianBusyStep')}
              </Notice>
            </div>
          )}
          {submissionText !== undefined && submission !== undefined && (
            <div className="px-4 pb-3">
              <Notice
                variant="inline"
                tone={submission.kind === 'rejected' ? 'negative' : 'neutral'}
                role={submission.kind === 'rejected' ? 'alert' : 'status'}
                errorId={submission.rowCopy === undefined ? submission.messageKey : undefined}
                data-testid="pending-activity-submission"
              >
                {submissionText}
              </Notice>
            </div>
          )}
          {feeBlocked && (
            <div className="px-4 pb-3">
              <Notice id={feeNoticeId} variant="inline" tone="warning" data-testid="pending-activity-fee-notice">
                {t('insufficientFeeAssetShort')}
              </Notice>
            </div>
          )}

          {/* The actions are ordinary design-system buttons: the app's pill, with the card's own
            padding around them. `className` here sets width only; nothing restyles a Button from
            the call site.
            They are `sm`, the same size as the Pending list's own Accept All — a row-level
            action, not a page's CTA. At `lg` two 48px pills with 19px labels sat under a 40px
            avatar row and took over the card; stacked cards read as a wall of orange. `pb-3`
            follows them down so the footer keeps the header row's 12px rhythm instead of leaving
            a band of empty space under a shorter button.
            The row's layout is STATIC: Decline takes 40%, Accept the rest, and a button is either
            there or it is not. The previous footer expanded Decline from 0 to 40% through an
            `AnimatePresence` with `initial={false}` — which only suppresses the entry animation
            for what is present when that `AnimatePresence` FIRST mounts. Switching the Activity
            filter renders a different list, so every card remounted and the width tween replayed
            from zero on each tab change, reflowing the whole footer. */}
          {/* The actions run edge to edge along the card's foot, square-cornered, under a hairline:
            the card's own rounded clip shapes the outer corners. */}
          <div className="flex border-t border-hairline">
            {onReject && status !== 'claiming' && (
              <Button
                variant={ButtonVariant.Ghost}
                size="sm"
                className="h-12 w-2/5 whitespace-nowrap rounded-none border-0"
                title={t('activityRejectTransfer')}
                disabled={!canAccept}
                onClick={() => onReject(note)}
              />
            )}
            {/* A claim in flight is the Button's own loading state: the accent fill stays, the
              label is swapped for the spinner at the label's width and taps are refused. It is
              NOT `disabled`, which would grey the one action in progress. */}
            <Button
              size="sm"
              className="h-12 min-w-0 flex-1 rounded-none"
              title={actionLabel}
              disabled={(!canAccept && !held && status !== 'claiming') || feeBlocked}
              isLoading={status === 'claiming' && !held}
              aria-busy={busy}
              aria-describedby={feeBlocked ? feeNoticeId : undefined}
              onClick={() => {
                // A loading Button refuses only pointer taps, so a keyboard press on a claim in flight stops here.
                if (busy) return;
                // Accepting IS the decision, so the transfer is read from here on even though no
                // detail page was opened.
                markActivityRead(unreadKey, note.receivedAt ?? Number.NaN);
                if (held) onRetryHeld?.(item);
                else onAccept(note);
              }}
            />
          </div>
        </article>
      </Card>
    </div>
  );
};
