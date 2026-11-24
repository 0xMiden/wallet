import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import {
  getNoteDeadletterSummary,
  type NoteDeadletterReasonSummary,
  type NoteDeadletterSummary
} from 'lib/miden/note-deadletter';
import { hapticLight } from 'lib/mobile/haptics';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';

export interface DeadletteredNotesNoticeProps {
  className?: string;
}

/**
 * How long a drain may hold the button disabled. The intercom request has no
 * deadline of its own and an MV3 worker teardown drops an in-flight one without
 * rejecting it, so an unbounded guard turns one unlucky press into a Retry the
 * user can never press again this session. Generous, because the drain still has
 * to re-queue every note and rewrite the whole store, and re-enabling under a
 * live drain is the thing the guard exists to prevent.
 */
const RETRY_GUARD_MAX_MS = 60_000;
const DEADLETTER_REASON_KEYS: Record<NoteDeadletterReasonSummary, string> = {
  transport: 'deadletteredNotesReasonTransport',
  malformed: 'deadletteredNotesReasonMalformed',
  rejected: 'deadletteredNotesReasonRejected',
  unavailable: 'deadletteredNotesReasonUnavailable'
};

/**
 * The drain surface for the note dead-letter store (#788 follow-up): notes the
 * wallet gave up importing automatically — whose bytes can be the only copy of
 * the funds they carry — surface here with a Retry, which is the manual drain
 * the store's refuse-at-cap contract assumes exists.
 *
 * The SIGNAL is read straight from storage on an SWR poll: the store lives in
 * the same layer on every platform (browser.storage.local / Capacitor
 * Preferences / prefixed localStorage), so no backend round trip is needed to
 * know the count, and polling works identically on the platforms that have no
 * storage-changed event. The DRAIN goes through the intercom action, because
 * the queue's writes must happen in the realm that owns the import pass — the
 * SW on extension — and a popup-side write would race its read-modify-writes.
 */
export const DeadletteredNotesNotice: FC<DeadletteredNotesNoticeProps> = ({ className }) => {
  const { t } = useTranslation();
  const { data, mutate } = useRetryableSWR<NoteDeadletterSummary>('deadlettered-notes', getNoteDeadletterSummary, {
    refreshInterval: 10_000
  });

  const count = data?.count ?? 0;
  const reasons = data?.reasons.map(reason => t(DEADLETTER_REASON_KEYS[reason])).join(', ') ?? '';
  useUserVisibleError(
    count === 0 ? null : count === 1 ? 'deadletteredNotesBodyOne' : 'deadletteredNotesBody',
    'inline'
  );
  const [retrying, setRetrying] = useState(false);
  // Set in the effect BODY, not just cleared in the cleanup: StrictMode invokes
  // setup, cleanup, setup, so an initializer-only `true` is false forever after
  // the first simulated unmount and the Retry button never re-enables.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onRetry = useCallback(() => {
    // Guarded against a second press, and not merely for tidiness: each drain
    // supersedes any import pass in flight, so N concurrent drains discard N-1
    // passes' banked attempts and backoff stamps. The count also cannot go to
    // zero until the drain returns, so an impatient user sees a live Retry over
    // a store that is already being emptied.
    if (retrying) return;
    setRetrying(true);
    hapticLight();
    let guard: ReturnType<typeof setTimeout>;
    const release = () => {
      clearTimeout(guard);
      if (mounted.current) setRetrying(false);
    };
    const timeout = new Promise<void>(resolve => {
      guard = setTimeout(resolve, RETRY_GUARD_MAX_MS);
    });
    void Promise.race([
      getIntercom()
        .request({ type: WalletMessageType.RetryDeadletteredNotesRequest })
        .catch(() => {})
        // Revalidate regardless of outcome: a partial drain (queue write failed
        // mid-way) leaves a smaller store, and the count shown should say so.
        .then(() => mutate())
        .catch(() => {}),
      timeout
    ]).then(release, release);
  }, [mutate, retrying]);

  if (count === 0) return null;

  return (
    <div
      className={classNames('min-h-[56px] flex items-center bg-white px-4 gap-x-2 py-2 rounded-2xl', className)}
      data-testid="deadlettered-notes-notice"
    >
      <div className="flex items-center">
        <Icon name={IconName.WarningFill} size="md" fill="#FEA644" />
      </div>
      <div className="flex-1 flex flex-col justify-center items-start min-w-0">
        <p className="text-ink text-sm font-medium">
          {count === 1 ? t('deadletteredNotesTitleOne') : t('deadletteredNotesTitle')}
        </p>
        <p className="text-text-muted text-xs">
          {count === 1 ? t('deadletteredNotesBodyOne') : t('deadletteredNotesBody', { count })}
        </p>
        {reasons && <p className="text-text-muted text-xs">{t('deadletteredNotesReasonSummary', { reasons })}</p>}
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="text-xs font-medium text-primary-500 px-2 py-1 rounded-md hover:bg-fill-pressed disabled:opacity-50"
      >
        {t('connectivityRetry')}
      </button>
    </div>
  );
};
